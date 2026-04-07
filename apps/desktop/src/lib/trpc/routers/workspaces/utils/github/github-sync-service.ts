/**
 * GitHubSyncService — centralized GitHub API polling for all workspaces.
 *
 * Instead of each UI surface independently polling the GitHub API, this
 * service runs per-workspace timers that proactively keep the backend
 * cache warm. Frontend tRPC queries read from the always-warm cache
 * without triggering additional API calls.
 *
 * Only the **active** workspace is polled. When the user switches to a
 * different workspace, the previous one is deactivated (timers stopped)
 * and the new one is activated (timers started).
 *
 * Intervals:
 *   - PR status: 30 seconds by default, 15 seconds while checks are pending
 *   - PR comments: 60 seconds for the currently attached PR only
 *
 * Rate limiting is handled by rateLimitedRefresh() in github.ts — the
 * SyncService does NOT call onRateLimitHit/Success directly to avoid
 * double-counting with the lower-level wrapper.
 *
 * --- FORK NOTE ---
 * This service is a fork-specific replacement for upstream's frontend
 * hover-debounce approach (useHoverGitHubStatus, commit be22b46dd, #3125).
 * Upstream fetches GitHub data on-demand from the frontend; this fork
 * centralizes polling in the backend for better API call efficiency.
 * See also: githubQueryPolicy.ts for the frontend cache-reading strategy.
 */

import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import type { PullRequestCommentsTarget } from "./github";
import { isRateLimited } from "./github-rate-limiter";

export const SYNC_PR_STATUS_INTERVAL_MS = 30_000;
export const SYNC_PR_STATUS_PENDING_INTERVAL_MS = 15_000;
export const SYNC_PR_COMMENTS_INTERVAL_MS = 60_000;

type FetchPRStatusFn = (worktreePath: string) => Promise<GitHubStatus | null>;
type FetchPRCommentsFn = (params: {
	worktreePath: string;
	pullRequest?: PullRequestCommentsTarget | null;
}) => Promise<PullRequestComment[]>;

interface WorkspaceSyncState {
	worktreePath: string;
	prStatusTimer: ReturnType<typeof setTimeout> | null;
	prCommentsTimer: ReturnType<typeof setTimeout> | null;
	isActive: boolean;
	prStatusInFlight: boolean;
	prCommentsInFlight: boolean;
	latestStatus: GitHubStatus | null;
}

interface SyncServiceDeps {
	fetchPRStatus: FetchPRStatusFn;
	fetchPRComments: FetchPRCommentsFn;
	onPRStatusUpdate?: (
		worktreePath: string,
		status: GitHubStatus | null,
	) => void;
}

class GitHubSyncServiceImpl {
	private workspaces = new Map<string, WorkspaceSyncState>();
	private deps: SyncServiceDeps | null = null;

	initialize(deps: SyncServiceDeps): void {
		this.deps = deps;
	}

	/**
	 * Register a workspace WITHOUT starting polling timers.
	 * The workspace is registered as inactive — call activateWorkspace()
	 * or setActiveWorkspace() to start polling.
	 *
	 * This prevents the "all workspaces poll until setActiveWorkspace
	 * arrives" race condition at startup.
	 */
	registerWorkspace(worktreePath: string): void {
		if (this.workspaces.has(worktreePath)) {
			return;
		}

		const state: WorkspaceSyncState = {
			worktreePath,
			prStatusTimer: null,
			prCommentsTimer: null,
			isActive: false,
			prStatusInFlight: false,
			prCommentsInFlight: false,
			latestStatus: null,
		};

		this.workspaces.set(worktreePath, state);
	}

	/**
	 * Unregister a workspace completely (e.g., workspace deleted).
	 * Stops timers and removes from the registry.
	 */
	unregisterWorkspace(worktreePath: string): void {
		const state = this.workspaces.get(worktreePath);
		if (!state) return;

		this.stopTimers(state);
		state.isActive = false;
		this.workspaces.delete(worktreePath);
	}

	/**
	 * Activate a workspace, starting its polling timers and triggering
	 * an immediate sync. If not yet registered, registers it first.
	 */
	activateWorkspace(worktreePath: string): void {
		let state = this.workspaces.get(worktreePath);

		if (!state) {
			this.registerWorkspace(worktreePath);
			const registeredState = this.workspaces.get(worktreePath);
			if (!registeredState) {
				return;
			}
			state = registeredState;
		}

		if (state.isActive) return;

		state.isActive = true;
		this.stopTimers(state);
		void this.primeWorkspace(worktreePath);
	}

	/**
	 * Deactivate a workspace, pausing its polling timers.
	 * The workspace remains in the registry and can be reactivated.
	 */
	deactivateWorkspace(worktreePath: string): void {
		const state = this.workspaces.get(worktreePath);
		if (!state || !state.isActive) return;

		state.isActive = false;
		this.stopTimers(state);
	}

	/**
	 * Deactivate all workspaces except the given one.
	 * Activates the given workspace if not already active.
	 * Pass null to deactivate all workspaces (e.g., navigating away from workspaces).
	 */
	setActiveWorkspace(worktreePath: string | null): void {
		for (const state of this.workspaces.values()) {
			if (worktreePath && state.worktreePath === worktreePath) {
				if (!state.isActive) {
					state.isActive = true;
					this.stopTimers(state);
					void this.primeWorkspace(state.worktreePath);
				}
			} else if (state.isActive) {
				state.isActive = false;
				this.stopTimers(state);
			}
		}

		// Register and activate if not yet known
		if (worktreePath && !this.workspaces.has(worktreePath)) {
			this.registerWorkspace(worktreePath);
			this.activateWorkspace(worktreePath);
		}
	}

	/**
	 * Deactivate all workspaces. Used when navigating away from workspace views.
	 */
	deactivateAll(): void {
		for (const state of this.workspaces.values()) {
			if (state.isActive) {
				state.isActive = false;
				this.stopTimers(state);
			}
		}
	}

	/**
	 * Trigger an immediate refresh for a workspace.
	 * Used after user mutations (merge, reviewer add, etc.)
	 * to provide instant feedback.
	 */
	async invalidate(
		worktreePath: string,
		scope: "all" | "prStatus" | "prComments" = "all",
	): Promise<void> {
		if (!this.deps) return;

		if (scope === "all" || scope === "prStatus") {
			await this.syncPRStatus(worktreePath);
		}
		if (scope === "all" || scope === "prComments") {
			await this.syncPRComments(worktreePath);
		}
	}

	/**
	 * Clean up all timers (e.g., on app quit).
	 */
	destroy(): void {
		for (const state of this.workspaces.values()) {
			this.stopTimers(state);
			state.isActive = false;
		}
		this.workspaces.clear();
	}

	isRegistered(worktreePath: string): boolean {
		return this.workspaces.has(worktreePath);
	}

	private async primeWorkspace(worktreePath: string): Promise<void> {
		await this.syncPRStatus(worktreePath);
	}

	private stopTimers(state: WorkspaceSyncState): void {
		if (state.prStatusTimer) {
			clearTimeout(state.prStatusTimer);
			state.prStatusTimer = null;
		}
		if (state.prCommentsTimer) {
			clearTimeout(state.prCommentsTimer);
			state.prCommentsTimer = null;
		}
	}

	private getPRStatusInterval(state: WorkspaceSyncState): number {
		return state.latestStatus?.pr?.checksStatus === "pending"
			? SYNC_PR_STATUS_PENDING_INTERVAL_MS
			: SYNC_PR_STATUS_INTERVAL_MS;
	}

	private scheduleNextPRStatusSync(state: WorkspaceSyncState): void {
		if (!state.isActive) {
			return;
		}

		if (state.prStatusTimer) {
			clearTimeout(state.prStatusTimer);
		}

		state.prStatusTimer = setTimeout(() => {
			void this.syncPRStatus(state.worktreePath);
		}, this.getPRStatusInterval(state));
	}

	private scheduleNextPRCommentsSync(state: WorkspaceSyncState): void {
		if (state.prCommentsTimer) {
			clearTimeout(state.prCommentsTimer);
			state.prCommentsTimer = null;
		}

		if (
			!state.isActive ||
			!getPullRequestCommentsTargetFromStatus(state.latestStatus)
		) {
			return;
		}

		state.prCommentsTimer = setTimeout(() => {
			void this.syncPRComments(state.worktreePath);
		}, SYNC_PR_COMMENTS_INTERVAL_MS);
	}

	private async syncPRStatus(worktreePath: string): Promise<void> {
		const state = this.workspaces.get(worktreePath);
		if (!this.deps || !state) return;
		if (state.prStatusTimer) {
			clearTimeout(state.prStatusTimer);
			state.prStatusTimer = null;
		}
		if (isRateLimited() || state.prStatusInFlight) {
			if (state.isActive && !state.prStatusInFlight) {
				this.scheduleNextPRStatusSync(state);
			}
			return;
		}
		state.prStatusInFlight = true;

		const previousCommentsTargetKey = getPullRequestCommentsTargetKey(
			state.latestStatus,
		);

		try {
			const status = await this.deps.fetchPRStatus(worktreePath);
			if (!this.workspaces.has(worktreePath)) return;
			state.latestStatus = status;
			this.deps.onPRStatusUpdate?.(worktreePath, status);

			const nextCommentsTargetKey = getPullRequestCommentsTargetKey(status);
			if (
				previousCommentsTargetKey !== nextCommentsTargetKey &&
				!state.prCommentsInFlight
			) {
				this.scheduleNextPRCommentsSync(state);
			}
		} catch (error) {
			console.warn("[GitHub SyncService] PR status sync failed:", error);
		} finally {
			const current = this.workspaces.get(worktreePath);
			if (current) {
				current.prStatusInFlight = false;
				this.scheduleNextPRStatusSync(current);
			}
		}
	}

	private async syncPRComments(worktreePath: string): Promise<void> {
		const state = this.workspaces.get(worktreePath);
		if (!this.deps || !state) return;
		if (state.prCommentsTimer) {
			clearTimeout(state.prCommentsTimer);
			state.prCommentsTimer = null;
		}
		if (isRateLimited() || state.prCommentsInFlight) {
			if (state.isActive && !state.prCommentsInFlight) {
				this.scheduleNextPRCommentsSync(state);
			}
			return;
		}

		const pullRequest = getPullRequestCommentsTargetFromStatus(
			state.latestStatus,
		);
		if (!pullRequest) {
			return;
		}

		state.prCommentsInFlight = true;

		try {
			await this.deps.fetchPRComments({ worktreePath, pullRequest });
			if (!this.workspaces.has(worktreePath)) return;
		} catch (error) {
			console.warn("[GitHub SyncService] PR comments sync failed:", error);
		} finally {
			const current = this.workspaces.get(worktreePath);
			if (current) {
				current.prCommentsInFlight = false;
				this.scheduleNextPRCommentsSync(current);
			}
		}
	}
}

function getPullRequestCommentsTargetFromStatus(
	status: GitHubStatus | null,
): PullRequestCommentsTarget | null {
	if (!status?.pr) {
		return null;
	}

	return {
		prNumber: status.pr.number,
		repoContext: {
			repoUrl: status.repoUrl,
			upstreamUrl: status.upstreamUrl ?? status.repoUrl,
			isFork: status.isFork ?? false,
		},
		prUrl: status.pr.url,
	};
}

function getPullRequestCommentsTargetKey(
	status: GitHubStatus | null,
): string | null {
	const target = getPullRequestCommentsTargetFromStatus(status);
	if (!target) {
		return null;
	}

	return `${target.repoContext.repoUrl}::${target.repoContext.upstreamUrl}::${target.prNumber}::${target.prUrl ?? ""}`;
}

export const githubSyncService = new GitHubSyncServiceImpl();
