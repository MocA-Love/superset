/**
 * GitHubSyncService — centralized GitHub API polling for all workspaces.
 *
 * Instead of each UI surface independently polling the GitHub API, this
 * service runs per-workspace timers that proactively keep the backend
 * cache warm. Frontend tRPC queries read from the always-warm cache
 * without triggering additional API calls.
 *
 * Intervals:
 *   - PR status: 5 seconds
 *   - PR comments: 20 seconds
 *
 * All GitHub API calls flow through this service, which provides:
 *   - Centralized rate limit detection + exponential backoff
 *   - Single API call path (no duplicate requests)
 *   - Immediate invalidation after user mutations
 *
 * Rate limiting is handled by rateLimitedRefresh() in github.ts — the
 * SyncService does NOT call onRateLimitHit/Success directly to avoid
 * double-counting with the lower-level wrapper.
 */

import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import { isRateLimited } from "./github-rate-limiter";

export const SYNC_PR_STATUS_INTERVAL_MS = 5_000;
export const SYNC_PR_COMMENTS_INTERVAL_MS = 20_000;

type FetchPRStatusFn = (worktreePath: string) => Promise<GitHubStatus | null>;
type FetchPRCommentsFn = (params: {
	worktreePath: string;
}) => Promise<PullRequestComment[]>;

interface WorkspaceSyncState {
	worktreePath: string;
	prStatusTimer: ReturnType<typeof setInterval> | null;
	prCommentsTimer: ReturnType<typeof setInterval> | null;
	isActive: boolean;
	prStatusInFlight: boolean;
	prCommentsInFlight: boolean;
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
	 * Register a workspace for proactive syncing.
	 * Called when a workspace becomes active (e.g., user opens it).
	 */
	registerWorkspace(worktreePath: string): void {
		if (this.workspaces.has(worktreePath)) {
			return;
		}

		const state: WorkspaceSyncState = {
			worktreePath,
			prStatusTimer: null,
			prCommentsTimer: null,
			isActive: true,
			prStatusInFlight: false,
			prCommentsInFlight: false,
		};

		this.workspaces.set(worktreePath, state);
		this.startTimers(state);
	}

	/**
	 * Unregister a workspace when it's no longer active.
	 */
	unregisterWorkspace(worktreePath: string): void {
		const state = this.workspaces.get(worktreePath);
		if (!state) return;

		this.stopTimers(state);
		state.isActive = false;
		this.workspaces.delete(worktreePath);
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
	 * Notify the service about a window focus event.
	 * Triggers one immediate sync cycle for all active workspaces.
	 * Errors are handled internally — fire-and-forget is intentional.
	 */
	onWindowFocus(): void {
		for (const state of this.workspaces.values()) {
			if (state.isActive) {
				void this.syncPRStatus(state.worktreePath);
				void this.syncPRComments(state.worktreePath);
			}
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

	private startTimers(state: WorkspaceSyncState): void {
		state.prStatusTimer = setInterval(() => {
			void this.syncPRStatus(state.worktreePath);
		}, SYNC_PR_STATUS_INTERVAL_MS);

		state.prCommentsTimer = setInterval(() => {
			void this.syncPRComments(state.worktreePath);
		}, SYNC_PR_COMMENTS_INTERVAL_MS);
	}

	private stopTimers(state: WorkspaceSyncState): void {
		if (state.prStatusTimer) {
			clearInterval(state.prStatusTimer);
			state.prStatusTimer = null;
		}
		if (state.prCommentsTimer) {
			clearInterval(state.prCommentsTimer);
			state.prCommentsTimer = null;
		}
	}

	private async syncPRStatus(worktreePath: string): Promise<void> {
		if (!this.deps || isRateLimited()) return;
		const state = this.workspaces.get(worktreePath);
		if (!state || state.prStatusInFlight) return;
		state.prStatusInFlight = true;

		try {
			const status = await this.deps.fetchPRStatus(worktreePath);
			if (!this.workspaces.has(worktreePath)) return;
			this.deps.onPRStatusUpdate?.(worktreePath, status);
		} catch (error) {
			console.warn("[GitHub SyncService] PR status sync failed:", error);
		} finally {
			const current = this.workspaces.get(worktreePath);
			if (current) current.prStatusInFlight = false;
		}
	}

	private async syncPRComments(worktreePath: string): Promise<void> {
		if (!this.deps || isRateLimited()) return;
		const state = this.workspaces.get(worktreePath);
		if (!state || state.prCommentsInFlight) return;
		state.prCommentsInFlight = true;

		try {
			await this.deps.fetchPRComments({ worktreePath });
			if (!this.workspaces.has(worktreePath)) return;
		} catch (error) {
			console.warn("[GitHub SyncService] PR comments sync failed:", error);
		} finally {
			const current = this.workspaces.get(worktreePath);
			if (current) current.prCommentsInFlight = false;
		}
	}
}

export const githubSyncService = new GitHubSyncServiceImpl();
