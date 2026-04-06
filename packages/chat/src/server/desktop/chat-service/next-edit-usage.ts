import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const USAGE_FILE_NAME = "chat-next-edit-usage.json";
const MAX_USAGE_EVENTS = 5000;
const INPUT_COST_PER_MILLION_TOKENS = 0.25;
const OUTPUT_COST_PER_MILLION_TOKENS = 1.0;

export const nextEditUsageEndpointSchema = z.enum(["fim", "next_edit"]);

export const nextEditUsageEventSchema = z.object({
	timestamp: z.string().datetime(),
	endpoint: nextEditUsageEndpointSchema,
	model: z.string().min(1),
	promptTokens: z.number().int().min(0),
	completionTokens: z.number().int().min(0),
	totalTokens: z.number().int().min(0),
	cachedInputTokens: z.number().int().min(0).optional(),
});

export type NextEditUsageEvent = z.infer<typeof nextEditUsageEventSchema>;
export type NextEditUsageEndpoint = z.infer<typeof nextEditUsageEndpointSchema>;

export interface NextEditUsageBucket {
	requestCount: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
}

export interface NextEditUsageSummary {
	today: NextEditUsageBucket;
	month: NextEditUsageBucket;
	allTime: NextEditUsageBucket;
	byEndpoint: Record<NextEditUsageEndpoint, NextEditUsageBucket>;
	lastUsedAt: string | null;
	pricing: {
		inputCostPerMillionTokensUsd: number;
		outputCostPerMillionTokensUsd: number;
	};
}

interface PersistedNextEditUsage {
	version: 1;
	events: NextEditUsageEvent[];
}

interface NextEditUsageDiskOptions {
	usagePath?: string;
}

const usageBucketSchema = z.object({
	requestCount: z.number().int().min(0),
	promptTokens: z.number().int().min(0),
	completionTokens: z.number().int().min(0),
	totalTokens: z.number().int().min(0),
	estimatedCostUsd: z.number().min(0),
});

const nextEditUsageSummarySchema = z.object({
	today: usageBucketSchema,
	month: usageBucketSchema,
	allTime: usageBucketSchema,
	byEndpoint: z.object({
		fim: usageBucketSchema,
		next_edit: usageBucketSchema,
	}),
	lastUsedAt: z.string().datetime().nullable(),
	pricing: z.object({
		inputCostPerMillionTokensUsd: z.number().min(0),
		outputCostPerMillionTokensUsd: z.number().min(0),
	}),
});

function createEmptyBucket(): NextEditUsageBucket {
	return {
		requestCount: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		estimatedCostUsd: 0,
	};
}

function addUsageEventToBucket(
	bucket: NextEditUsageBucket,
	event: NextEditUsageEvent,
): void {
	bucket.requestCount += 1;
	bucket.promptTokens += event.promptTokens;
	bucket.completionTokens += event.completionTokens;
	bucket.totalTokens += event.totalTokens;
	bucket.estimatedCostUsd +=
		(event.promptTokens / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS +
		(event.completionTokens / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS;
}

function roundUsd(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeBucket(bucket: NextEditUsageBucket): NextEditUsageBucket {
	return {
		...bucket,
		estimatedCostUsd: roundUsd(bucket.estimatedCostUsd),
	};
}

function normalizeSummary(summary: NextEditUsageSummary): NextEditUsageSummary {
	return nextEditUsageSummarySchema.parse({
		...summary,
		today: normalizeBucket(summary.today),
		month: normalizeBucket(summary.month),
		allTime: normalizeBucket(summary.allTime),
		byEndpoint: {
			fim: normalizeBucket(summary.byEndpoint.fim),
			next_edit: normalizeBucket(summary.byEndpoint.next_edit),
		},
	});
}

function createEmptySummary(): NextEditUsageSummary {
	return normalizeSummary({
		today: createEmptyBucket(),
		month: createEmptyBucket(),
		allTime: createEmptyBucket(),
		byEndpoint: {
			fim: createEmptyBucket(),
			next_edit: createEmptyBucket(),
		},
		lastUsedAt: null,
		pricing: {
			inputCostPerMillionTokensUsd: INPUT_COST_PER_MILLION_TOKENS,
			outputCostPerMillionTokensUsd: OUTPUT_COST_PER_MILLION_TOKENS,
		},
	});
}

export function getNextEditUsagePath(
	options?: NextEditUsageDiskOptions,
): string {
	if (options?.usagePath) return options.usagePath;
	const supersetHome =
		process.env.SUPERSET_HOME_DIR?.trim() || join(homedir(), ".superset");
	return join(supersetHome, USAGE_FILE_NAME);
}

function readPersistedNextEditUsage(
	options?: NextEditUsageDiskOptions,
): PersistedNextEditUsage | null {
	const usagePath = getNextEditUsagePath(options);
	if (!existsSync(usagePath)) return null;

	try {
		const parsed = JSON.parse(
			readFileSync(usagePath, "utf-8"),
		) as Partial<PersistedNextEditUsage>;
		const events = z.array(nextEditUsageEventSchema).safeParse(parsed.events);
		if (parsed.version !== 1 || !events.success) {
			return null;
		}

		return {
			version: 1,
			events: events.data,
		};
	} catch (error) {
		console.warn("[chat-service][next-edit-usage] Failed to read usage log.", {
			usagePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function writePersistedNextEditUsage(
	persisted: PersistedNextEditUsage,
	options?: NextEditUsageDiskOptions,
): void {
	const usagePath = getNextEditUsagePath(options);
	const dir = dirname(usagePath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(usagePath, JSON.stringify(persisted, null, 2), "utf-8");
	chmodSync(usagePath, 0o600);
}

export function recordNextEditUsageEvent(
	event: NextEditUsageEvent,
	options?: NextEditUsageDiskOptions,
): void {
	const normalizedEvent = nextEditUsageEventSchema.parse(event);
	const persisted = readPersistedNextEditUsage(options) ?? {
		version: 1 as const,
		events: [],
	};
	const nextEvents = [...persisted.events, normalizedEvent].slice(
		-MAX_USAGE_EVENTS,
	);
	writePersistedNextEditUsage(
		{
			version: 1,
			events: nextEvents,
		},
		options,
	);
}

export function getNextEditUsageSummary(
	options?: NextEditUsageDiskOptions,
): NextEditUsageSummary {
	const persisted = readPersistedNextEditUsage(options);
	if (!persisted || persisted.events.length === 0) {
		return createEmptySummary();
	}

	const now = new Date();
	const todayKey = now.toISOString().slice(0, 10);
	const monthKey = todayKey.slice(0, 7);
	const summary: NextEditUsageSummary = {
		today: createEmptyBucket(),
		month: createEmptyBucket(),
		allTime: createEmptyBucket(),
		byEndpoint: {
			fim: createEmptyBucket(),
			next_edit: createEmptyBucket(),
		},
		lastUsedAt: persisted.events[persisted.events.length - 1]?.timestamp ?? null,
		pricing: {
			inputCostPerMillionTokensUsd: INPUT_COST_PER_MILLION_TOKENS,
			outputCostPerMillionTokensUsd: OUTPUT_COST_PER_MILLION_TOKENS,
		},
	};

	for (const event of persisted.events) {
		addUsageEventToBucket(summary.allTime, event);
		addUsageEventToBucket(summary.byEndpoint[event.endpoint], event);
		const eventDate = event.timestamp.slice(0, 10);
		if (eventDate === todayKey) {
			addUsageEventToBucket(summary.today, event);
		}
		if (eventDate.startsWith(monthKey)) {
			addUsageEventToBucket(summary.month, event);
		}
	}

	return normalizeSummary(summary);
}

export function extractUsageEventFromResponse(args: {
	endpoint: NextEditUsageEndpoint;
	model: string;
	response: Record<string, unknown>;
	now?: Date;
}): NextEditUsageEvent | null {
	const usage =
		typeof args.response.usage === "object" && args.response.usage !== null
			? (args.response.usage as Record<string, unknown>)
			: null;
	if (!usage) {
		return null;
	}

	const promptTokens =
		typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
	const completionTokens =
		typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
	const totalTokens =
		typeof usage.total_tokens === "number" ? usage.total_tokens : null;

	if (promptTokens === null || completionTokens === null || totalTokens === null) {
		return null;
	}

	const cachedInputTokens =
		typeof usage.cached_input_tokens === "number"
			? usage.cached_input_tokens
			: undefined;

	return nextEditUsageEventSchema.parse({
		timestamp: (args.now ?? new Date()).toISOString(),
		endpoint: args.endpoint,
		model: args.model,
		promptTokens,
		completionTokens,
		totalTokens,
		cachedInputTokens,
	});
}
