/**
 * Polling intervals for frontend React Query refetch.
 *
 * These intervals trigger tRPC queries that read from the backend cache
 * (warmed by GitHubSyncService). They do NOT cause additional GitHub API
 * calls — the backend cached-resource layer returns cached data within TTL.
 *
 * The frontend polling ensures React Query picks up the latest data that
 * the SyncService has fetched, keeping the UI in sync.
 *
 * --- FORK NOTE ---
 * Upstream (superset-sh/superset) uses a different approach: frontend-driven
 * hover-debounce polling via useHoverGitHubStatus hook (commit be22b46dd, #3125).
 * This fork intentionally diverges by using a backend-centralized SyncService
 * (see github-sync-service.ts) that reduces GitHub API calls by polling from
 * the backend and serving cached data to the frontend.
 *
 * When merging upstream changes to this file or related GitHub polling code,
 * prefer keeping the SyncService architecture unless upstream's approach
 * has evolved to match or exceed the efficiency of backend-centralized polling.
 */
const ACTIVE_GITHUB_STATUS_REFETCH_INTERVAL_MS = 5_000;
const ACTIVE_GITHUB_STATUS_STALE_TIME_MS = 5_000;
const WORKSPACE_LIST_ITEM_GITHUB_STATUS_STALE_TIME_MS = 30_000;
const PASSIVE_GITHUB_STATUS_STALE_TIME_MS = 5 * 60 * 1000;
const GITHUB_PR_COMMENTS_REFETCH_INTERVAL_MS = 20_000;
const GITHUB_PR_COMMENTS_STALE_TIME_MS = 20_000;

export type GitHubStatusQuerySurface =
	| "changes-sidebar"
	| "workspace-page"
	| "workspace-hover-card"
	| "workspace-list-item"
	| "workspace-row";

export interface GitHubQueryPolicy {
	enabled: boolean;
	refetchInterval: number | false;
	refetchOnWindowFocus: boolean;
	staleTime: number;
}

interface GitHubStatusQueryPolicyOptions {
	hasWorkspaceId: boolean;
	isActive?: boolean;
	isReviewTabActive?: boolean;
}

interface GitHubPRCommentsQueryPolicyOptions {
	hasWorkspaceId: boolean;
	hasActivePullRequest: boolean;
	isActive?: boolean;
	isReviewTabActive?: boolean;
}

/**
 * Centralizes GitHub query behavior so passive hover surfaces stay cheap while
 * active workspace surfaces still revalidate when they become relevant again.
 *
 * refetchOnWindowFocus is disabled for all surfaces — the GitHubSyncService
 * keeps the backend cache warm, preventing burst API calls on window focus.
 *
 * refetchInterval on active surfaces reads from the backend cache (no API call).
 * Passive surfaces rely on staleTime + mount-time fetch only.
 */
export function getGitHubStatusQueryPolicy(
	surface: GitHubStatusQuerySurface,
	{
		hasWorkspaceId,
		isActive = true,
		isReviewTabActive = false,
	}: GitHubStatusQueryPolicyOptions,
): GitHubQueryPolicy {
	const isEnabled = hasWorkspaceId && isActive;

	switch (surface) {
		case "changes-sidebar":
			return {
				enabled: isEnabled,
				refetchInterval:
					isEnabled && isReviewTabActive
						? ACTIVE_GITHUB_STATUS_REFETCH_INTERVAL_MS
						: false,
				refetchOnWindowFocus: false,
				staleTime: isReviewTabActive ? ACTIVE_GITHUB_STATUS_STALE_TIME_MS : 0,
			};
		case "workspace-page":
			return {
				enabled: isEnabled,
				refetchInterval: false,
				refetchOnWindowFocus: false,
				staleTime: PASSIVE_GITHUB_STATUS_STALE_TIME_MS,
			};
		case "workspace-list-item":
			return {
				enabled: isEnabled,
				refetchInterval: false,
				refetchOnWindowFocus: false,
				staleTime: WORKSPACE_LIST_ITEM_GITHUB_STATUS_STALE_TIME_MS,
			};
		case "workspace-hover-card":
		case "workspace-row":
			return {
				enabled: isEnabled,
				refetchInterval: false,
				refetchOnWindowFocus: false,
				staleTime: PASSIVE_GITHUB_STATUS_STALE_TIME_MS,
			};
	}
}

export function getGitHubPRCommentsQueryPolicy({
	hasWorkspaceId,
	hasActivePullRequest,
	isActive = true,
	isReviewTabActive = false,
}: GitHubPRCommentsQueryPolicyOptions): GitHubQueryPolicy {
	const isEnabled = hasWorkspaceId && isActive && hasActivePullRequest;

	return {
		enabled: isEnabled,
		refetchInterval:
			isEnabled && isReviewTabActive
				? GITHUB_PR_COMMENTS_REFETCH_INTERVAL_MS
				: false,
		refetchOnWindowFocus: false,
		staleTime: GITHUB_PR_COMMENTS_STALE_TIME_MS,
	};
}
