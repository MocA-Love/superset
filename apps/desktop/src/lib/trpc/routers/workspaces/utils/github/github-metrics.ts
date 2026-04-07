const ROLLING_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECENT_OPERATION_EVENTS = 2000;
const MAX_RECENT_CACHE_EVENTS = 2000;
const MAX_LAST_ERRORS = 20;

export type GitHubMetricOperationCategory = "sync" | "gh";
export type GitHubCacheMetricKind = "status" | "comments" | "preview";
export type GitHubCacheMetricEvent =
	| "fresh_hit"
	| "stale_hit"
	| "miss"
	| "force_fresh"
	| "write"
	| "invalidate";

interface OperationEvent {
	timestamp: number;
	name: string;
	category: GitHubMetricOperationCategory;
	success: boolean;
	rateLimited: boolean;
	durationMs: number;
	worktreePath: string | null;
	errorMessage: string | null;
}

interface CacheEvent {
	timestamp: number;
	kind: GitHubCacheMetricKind;
	event: GitHubCacheMetricEvent;
	worktreePath: string | null;
}

interface OperationAggregateWorkspace {
	calls: number;
	successes: number;
	failures: number;
	rateLimited: number;
	lastRunAt: number | null;
}

interface OperationAggregate {
	name: string;
	category: GitHubMetricOperationCategory;
	calls: number;
	successes: number;
	failures: number;
	rateLimited: number;
	totalDurationMs: number;
	maxDurationMs: number;
	lastDurationMs: number | null;
	lastRunAt: number | null;
	lastErrorAt: number | null;
	lastErrorMessage: string | null;
	workspaces: Map<string, OperationAggregateWorkspace>;
}

interface CacheAggregate {
	kind: GitHubCacheMetricKind;
	freshHits: number;
	staleHits: number;
	misses: number;
	forceFresh: number;
	writes: number;
	invalidations: number;
}

interface LastErrorEntry {
	at: number;
	operation: string;
	category: GitHubMetricOperationCategory;
	message: string;
	worktreePath: string | null;
}

export interface GitHubOperationWorkspaceBreakdown {
	worktreePath: string;
	sessionCalls: number;
	rolling5mCalls: number;
	lastRunAt: number | null;
}

export interface GitHubOperationMetricSnapshot {
	name: string;
	category: GitHubMetricOperationCategory;
	session: {
		calls: number;
		successes: number;
		failures: number;
		rateLimited: number;
		avgDurationMs: number;
		maxDurationMs: number;
	};
	rolling5m: {
		calls: number;
		successes: number;
		failures: number;
		rateLimited: number;
		avgDurationMs: number;
		maxDurationMs: number;
	};
	lastRunAt: number | null;
	lastDurationMs: number | null;
	lastErrorAt: number | null;
	lastErrorMessage: string | null;
	workspaces: GitHubOperationWorkspaceBreakdown[];
}

export interface GitHubCacheMetricSnapshot {
	kind: GitHubCacheMetricKind;
	session: CacheAggregateCounts;
	rolling5m: CacheAggregateCounts;
}

interface CacheAggregateCounts {
	freshHits: number;
	staleHits: number;
	misses: number;
	forceFresh: number;
	writes: number;
	invalidations: number;
}

export interface GitHubMetricsSnapshot {
	sessionStartedAt: number;
	generatedAt: number;
	totals: {
		sessionCallCount: number;
		sessionFailureCount: number;
		rolling5mCallCount: number;
		rolling5mFailureCount: number;
		rolling5mRateLimitedCount: number;
	};
	operations: GitHubOperationMetricSnapshot[];
	caches: GitHubCacheMetricSnapshot[];
	lastErrors: LastErrorEntry[];
}

const sessionStartedAt = Date.now();
const operationAggregates = new Map<string, OperationAggregate>();
const cacheAggregates = new Map<GitHubCacheMetricKind, CacheAggregate>();
const recentOperationEvents: OperationEvent[] = [];
const recentCacheEvents: CacheEvent[] = [];
const lastErrors: LastErrorEntry[] = [];

function trimRecentEvents(now: number): void {
	const operationCutoff = now - ROLLING_WINDOW_MS;
	while (
		recentOperationEvents.length > 0 &&
		(recentOperationEvents.length > MAX_RECENT_OPERATION_EVENTS ||
			recentOperationEvents[0]?.timestamp < operationCutoff)
	) {
		recentOperationEvents.shift();
	}

	while (
		recentCacheEvents.length > 0 &&
		(recentCacheEvents.length > MAX_RECENT_CACHE_EVENTS ||
			recentCacheEvents[0]?.timestamp < operationCutoff)
	) {
		recentCacheEvents.shift();
	}
}

function getOperationAggregateKey(
	name: string,
	category: GitHubMetricOperationCategory,
): string {
	return `${category}:${name}`;
}

function getOrCreateOperationAggregate({
	name,
	category,
}: {
	name: string;
	category: GitHubMetricOperationCategory;
}): OperationAggregate {
	const key = getOperationAggregateKey(name, category);
	const existing = operationAggregates.get(key);
	if (existing) {
		return existing;
	}

	const aggregate: OperationAggregate = {
		name,
		category,
		calls: 0,
		successes: 0,
		failures: 0,
		rateLimited: 0,
		totalDurationMs: 0,
		maxDurationMs: 0,
		lastDurationMs: null,
		lastRunAt: null,
		lastErrorAt: null,
		lastErrorMessage: null,
		workspaces: new Map<string, OperationAggregateWorkspace>(),
	};
	operationAggregates.set(key, aggregate);
	return aggregate;
}

function getOrCreateCacheAggregate(
	kind: GitHubCacheMetricKind,
): CacheAggregate {
	const existing = cacheAggregates.get(kind);
	if (existing) {
		return existing;
	}

	const aggregate: CacheAggregate = {
		kind,
		freshHits: 0,
		staleHits: 0,
		misses: 0,
		forceFresh: 0,
		writes: 0,
		invalidations: 0,
	};
	cacheAggregates.set(kind, aggregate);
	return aggregate;
}

function normalizeErrorMessage(error: unknown): string | null {
	if (error instanceof Error) {
		return error.message.slice(0, 300);
	}

	if (typeof error === "string") {
		return error.slice(0, 300);
	}

	return null;
}

function recordLastError(entry: LastErrorEntry): void {
	lastErrors.push(entry);
	if (lastErrors.length > MAX_LAST_ERRORS) {
		lastErrors.shift();
	}
}

export function trackGitHubOperationEvent({
	name,
	category,
	worktreePath = null,
	success,
	durationMs,
	rateLimited = false,
	error,
}: {
	name: string;
	category: GitHubMetricOperationCategory;
	worktreePath?: string | null;
	success: boolean;
	durationMs: number;
	rateLimited?: boolean;
	error?: unknown;
}): void {
	const now = Date.now();
	trimRecentEvents(now);

	const errorMessage = success ? null : normalizeErrorMessage(error);
	const aggregate = getOrCreateOperationAggregate({ name, category });
	aggregate.calls += 1;
	aggregate.successes += success ? 1 : 0;
	aggregate.failures += success ? 0 : 1;
	aggregate.rateLimited += rateLimited ? 1 : 0;
	aggregate.totalDurationMs += durationMs;
	aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
	aggregate.lastDurationMs = durationMs;
	aggregate.lastRunAt = now;

	if (errorMessage) {
		aggregate.lastErrorAt = now;
		aggregate.lastErrorMessage = errorMessage;
		recordLastError({
			at: now,
			operation: name,
			category,
			message: errorMessage,
			worktreePath,
		});
	}

	if (worktreePath) {
		const workspaceAggregate = aggregate.workspaces.get(worktreePath) ?? {
			calls: 0,
			successes: 0,
			failures: 0,
			rateLimited: 0,
			lastRunAt: null,
		};
		workspaceAggregate.calls += 1;
		workspaceAggregate.successes += success ? 1 : 0;
		workspaceAggregate.failures += success ? 0 : 1;
		workspaceAggregate.rateLimited += rateLimited ? 1 : 0;
		workspaceAggregate.lastRunAt = now;
		aggregate.workspaces.set(worktreePath, workspaceAggregate);
	}

	recentOperationEvents.push({
		timestamp: now,
		name,
		category,
		success,
		rateLimited,
		durationMs,
		worktreePath,
		errorMessage,
	});
}

export async function trackGitHubOperation<T>({
	name,
	category,
	worktreePath = null,
	fn,
}: {
	name: string;
	category: GitHubMetricOperationCategory;
	worktreePath?: string | null;
	fn: () => Promise<T>;
}): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await fn();
		trackGitHubOperationEvent({
			name,
			category,
			worktreePath,
			success: true,
			durationMs: Date.now() - startedAt,
		});
		return result;
	} catch (error) {
		trackGitHubOperationEvent({
			name,
			category,
			worktreePath,
			success: false,
			durationMs: Date.now() - startedAt,
			error,
		});
		throw error;
	}
}

export function recordGitHubCacheMetric({
	kind,
	event,
	worktreePath = null,
}: {
	kind: GitHubCacheMetricKind;
	event: GitHubCacheMetricEvent;
	worktreePath?: string | null;
}): void {
	const now = Date.now();
	trimRecentEvents(now);

	const aggregate = getOrCreateCacheAggregate(kind);
	switch (event) {
		case "fresh_hit":
			aggregate.freshHits += 1;
			break;
		case "stale_hit":
			aggregate.staleHits += 1;
			break;
		case "miss":
			aggregate.misses += 1;
			break;
		case "force_fresh":
			aggregate.forceFresh += 1;
			break;
		case "write":
			aggregate.writes += 1;
			break;
		case "invalidate":
			aggregate.invalidations += 1;
			break;
	}

	recentCacheEvents.push({
		timestamp: now,
		kind,
		event,
		worktreePath,
	});
}

export function getGitHubMetricsSnapshot(): GitHubMetricsSnapshot {
	const now = Date.now();
	trimRecentEvents(now);
	const rollingOperationCutoff = now - ROLLING_WINDOW_MS;
	const recentOperations = recentOperationEvents.filter(
		(event) => event.timestamp >= rollingOperationCutoff,
	);
	const recentCaches = recentCacheEvents.filter(
		(event) => event.timestamp >= rollingOperationCutoff,
	);

	const operations = [...operationAggregates.values()]
		.map((aggregate) => {
			const rolling = recentOperations.filter(
				(event) =>
					event.name === aggregate.name &&
					event.category === aggregate.category,
			);
			const rollingWorkspaceMap = new Map<
				string,
				{ calls: number; lastRunAt: number | null }
			>();

			for (const event of rolling) {
				if (!event.worktreePath) {
					continue;
				}
				const workspaceEntry = rollingWorkspaceMap.get(event.worktreePath) ?? {
					calls: 0,
					lastRunAt: null,
				};
				workspaceEntry.calls += 1;
				workspaceEntry.lastRunAt = event.timestamp;
				rollingWorkspaceMap.set(event.worktreePath, workspaceEntry);
			}

			const rollingTotalDurationMs = rolling.reduce(
				(total, event) => total + event.durationMs,
				0,
			);

			const workspaces = [...aggregate.workspaces.entries()]
				.map(([worktreePath, workspaceAggregate]) => ({
					worktreePath,
					sessionCalls: workspaceAggregate.calls,
					rolling5mCalls: rollingWorkspaceMap.get(worktreePath)?.calls ?? 0,
					lastRunAt:
						rollingWorkspaceMap.get(worktreePath)?.lastRunAt ??
						workspaceAggregate.lastRunAt,
				}))
				.sort((left, right) => right.sessionCalls - left.sessionCalls);

			return {
				name: aggregate.name,
				category: aggregate.category,
				session: {
					calls: aggregate.calls,
					successes: aggregate.successes,
					failures: aggregate.failures,
					rateLimited: aggregate.rateLimited,
					avgDurationMs:
						aggregate.calls > 0
							? aggregate.totalDurationMs / aggregate.calls
							: 0,
					maxDurationMs: aggregate.maxDurationMs,
				},
				rolling5m: {
					calls: rolling.length,
					successes: rolling.filter((event) => event.success).length,
					failures: rolling.filter((event) => !event.success).length,
					rateLimited: rolling.filter((event) => event.rateLimited).length,
					avgDurationMs:
						rolling.length > 0 ? rollingTotalDurationMs / rolling.length : 0,
					maxDurationMs: rolling.reduce(
						(max, event) => Math.max(max, event.durationMs),
						0,
					),
				},
				lastRunAt: aggregate.lastRunAt,
				lastDurationMs: aggregate.lastDurationMs,
				lastErrorAt: aggregate.lastErrorAt,
				lastErrorMessage: aggregate.lastErrorMessage,
				workspaces,
			};
		})
		.sort((left, right) => {
			if (right.rolling5m.calls !== left.rolling5m.calls) {
				return right.rolling5m.calls - left.rolling5m.calls;
			}
			return right.session.calls - left.session.calls;
		});

	const caches: GitHubCacheMetricSnapshot[] = (
		["status", "comments", "preview"] as const
	).map((kind) => {
		const session = cacheAggregates.get(kind) ?? {
			kind,
			freshHits: 0,
			staleHits: 0,
			misses: 0,
			forceFresh: 0,
			writes: 0,
			invalidations: 0,
		};
		const rolling = recentCaches.filter((event) => event.kind === kind);
		const rollingCounts = rolling.reduce<CacheAggregateCounts>(
			(counts, event) => {
				switch (event.event) {
					case "fresh_hit":
						counts.freshHits += 1;
						break;
					case "stale_hit":
						counts.staleHits += 1;
						break;
					case "miss":
						counts.misses += 1;
						break;
					case "force_fresh":
						counts.forceFresh += 1;
						break;
					case "write":
						counts.writes += 1;
						break;
					case "invalidate":
						counts.invalidations += 1;
						break;
				}
				return counts;
			},
			{
				freshHits: 0,
				staleHits: 0,
				misses: 0,
				forceFresh: 0,
				writes: 0,
				invalidations: 0,
			},
		);

		return {
			kind,
			session: {
				freshHits: session.freshHits,
				staleHits: session.staleHits,
				misses: session.misses,
				forceFresh: session.forceFresh,
				writes: session.writes,
				invalidations: session.invalidations,
			},
			rolling5m: rollingCounts,
		};
	});

	return {
		sessionStartedAt,
		generatedAt: now,
		totals: {
			sessionCallCount: operations.reduce(
				(total, operation) => total + operation.session.calls,
				0,
			),
			sessionFailureCount: operations.reduce(
				(total, operation) => total + operation.session.failures,
				0,
			),
			rolling5mCallCount: operations.reduce(
				(total, operation) => total + operation.rolling5m.calls,
				0,
			),
			rolling5mFailureCount: operations.reduce(
				(total, operation) => total + operation.rolling5m.failures,
				0,
			),
			rolling5mRateLimitedCount: operations.reduce(
				(total, operation) => total + operation.rolling5m.rateLimited,
				0,
			),
		},
		operations,
		caches,
		lastErrors: [...lastErrors].reverse(),
	};
}
