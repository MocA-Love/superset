import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import {
	type CachedResourceReadOptions,
	type CacheState,
	createCachedResource,
} from "./cached-resource";
import { recordGitHubCacheMetric } from "./github-metrics";
import type { RepoContext } from "./types";

const GITHUB_STATUS_CACHE_TTL_MS = 30_000;
const GITHUB_PR_COMMENTS_CACHE_TTL_MS = 60_000;
const GITHUB_PREVIEW_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const GITHUB_REPO_CONTEXT_CACHE_TTL_MS = 300_000;
const GITHUB_COMMIT_AUTHOR_CACHE_TTL_MS = 300_000;
const GITHUB_NO_PR_MATCH_CACHE_TTL_MS = 120_000;

const MAX_GITHUB_STATUS_CACHE_ENTRIES = 256;
const MAX_GITHUB_PR_COMMENTS_CACHE_ENTRIES = 512;
const MAX_GITHUB_PREVIEW_URL_CACHE_ENTRIES = 512;
const MAX_GITHUB_REPO_CONTEXT_CACHE_ENTRIES = 256;
const MAX_GITHUB_COMMIT_AUTHOR_CACHE_ENTRIES = 2048;
const MAX_GITHUB_NO_PR_MATCH_CACHE_ENTRIES = 512;

const githubStatusResource = createCachedResource<GitHubStatus | null>({
	ttlMs: GITHUB_STATUS_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_STATUS_CACHE_ENTRIES,
});

const pullRequestCommentsResource = createCachedResource<PullRequestComment[]>({
	ttlMs: GITHUB_PR_COMMENTS_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_PR_COMMENTS_CACHE_ENTRIES,
});

const previewUrlResource = createCachedResource<string | null>({
	ttlMs: GITHUB_PREVIEW_URL_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_PREVIEW_URL_CACHE_ENTRIES,
});

const repoContextResource = createCachedResource<RepoContext | null>({
	ttlMs: GITHUB_REPO_CONTEXT_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_REPO_CONTEXT_CACHE_ENTRIES,
});

const noPullRequestMatchResource = createCachedResource<true>({
	ttlMs: GITHUB_NO_PR_MATCH_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_NO_PR_MATCH_CACHE_ENTRIES,
});

export interface GitHubCommitAuthor {
	login: string | null;
	avatarUrl: string | null;
}

const commitAuthorResource = createCachedResource<GitHubCommitAuthor | null>({
	ttlMs: GITHUB_COMMIT_AUTHOR_CACHE_TTL_MS,
	maxEntries: MAX_GITHUB_COMMIT_AUTHOR_CACHE_ENTRIES,
});

export function getCachedGitHubStatus(
	worktreePath: string,
): GitHubStatus | null {
	const cachedState = githubStatusResource.getState(worktreePath);
	const cached = cachedState?.isFresh ? cachedState.value : null;
	recordGitHubCacheMetric({
		kind: "status",
		event: cachedState?.isFresh ? "fresh_hit" : "miss",
		worktreePath,
	});
	return cached;
}

export function getCachedGitHubStatusState(
	worktreePath: string,
): CacheState<GitHubStatus | null> | null {
	return githubStatusResource.getState(worktreePath);
}

export function setCachedGitHubStatus(
	worktreePath: string,
	value: GitHubStatus,
): void {
	githubStatusResource.set(worktreePath, value);
	recordGitHubCacheMetric({
		kind: "status",
		event: "write",
		worktreePath,
	});
}

export function readCachedGitHubStatus(
	worktreePath: string,
	load: () => Promise<GitHubStatus | null>,
	options?: CachedResourceReadOptions<GitHubStatus | null>,
): Promise<GitHubStatus | null> {
	const cached = githubStatusResource.getState(worktreePath);
	recordGitHubCacheMetric({
		kind: "status",
		event: options?.forceFresh
			? "force_fresh"
			: cached?.isFresh
				? "fresh_hit"
				: cached
					? "stale_hit"
					: "miss",
		worktreePath,
	});

	return githubStatusResource.read(worktreePath, load, {
		...options,
		shouldCache:
			options?.shouldCache ??
			((value) => {
				const shouldCache = value !== null;
				if (shouldCache) {
					recordGitHubCacheMetric({
						kind: "status",
						event: "write",
						worktreePath,
					});
				}
				return shouldCache;
			}),
	});
}

export function makePullRequestCommentsCachePrefix(
	worktreePath: string,
): string {
	return `${worktreePath}::comments::`;
}

export function makePullRequestCommentsCacheKey({
	worktreePath,
	repoNameWithOwner,
	pullRequestNumber,
}: {
	worktreePath: string;
	repoNameWithOwner: string;
	pullRequestNumber: number;
}): string {
	return `${makePullRequestCommentsCachePrefix(worktreePath)}${repoNameWithOwner}#${pullRequestNumber}`;
}

export function getCachedPullRequestComments(
	cacheKey: string,
): PullRequestComment[] | null {
	const cachedState = pullRequestCommentsResource.getState(cacheKey);
	const cached = cachedState?.isFresh ? cachedState.value : null;
	recordGitHubCacheMetric({
		kind: "comments",
		event: cachedState?.isFresh ? "fresh_hit" : "miss",
		worktreePath: extractWorktreePathFromCacheKey(cacheKey),
	});
	return cached;
}

export function getCachedPullRequestCommentsState(
	cacheKey: string,
): CacheState<PullRequestComment[]> | null {
	return pullRequestCommentsResource.getState(cacheKey);
}

export function setCachedPullRequestComments(
	cacheKey: string,
	value: PullRequestComment[],
): void {
	pullRequestCommentsResource.set(cacheKey, value);
	recordGitHubCacheMetric({
		kind: "comments",
		event: "write",
		worktreePath: extractWorktreePathFromCacheKey(cacheKey),
	});
}

export function readCachedPullRequestComments(
	cacheKey: string,
	load: () => Promise<PullRequestComment[]>,
	options?: CachedResourceReadOptions<PullRequestComment[]>,
): Promise<PullRequestComment[]> {
	const worktreePath = extractWorktreePathFromCacheKey(cacheKey);
	const cached = pullRequestCommentsResource.getState(cacheKey);
	recordGitHubCacheMetric({
		kind: "comments",
		event: options?.forceFresh
			? "force_fresh"
			: cached?.isFresh
				? "fresh_hit"
				: cached
					? "stale_hit"
					: "miss",
		worktreePath,
	});

	return pullRequestCommentsResource.read(
		cacheKey,
		async () => {
			const value = await load();
			recordGitHubCacheMetric({
				kind: "comments",
				event: "write",
				worktreePath,
			});
			return value;
		},
		options,
	);
}

export function makeGitHubPreviewCachePrefix(worktreePath: string): string {
	return `${worktreePath}::preview::`;
}

export function makeGitHubNoPullRequestCachePrefix(
	worktreePath: string,
): string {
	return `${worktreePath}::no-pr::`;
}

export function makeGitHubNoPullRequestCacheKey({
	worktreePath,
	localBranch,
	headSha,
}: {
	worktreePath: string;
	localBranch: string;
	headSha?: string;
}): string {
	return `${makeGitHubNoPullRequestCachePrefix(worktreePath)}${localBranch}::${headSha ?? "no-head"}`;
}

export function hasCachedNoPullRequestMatch(cacheKey: string): boolean {
	return noPullRequestMatchResource.get(cacheKey) === true;
}

export function setCachedNoPullRequestMatch(cacheKey: string): void {
	noPullRequestMatchResource.set(cacheKey, true);
}

export function clearCachedNoPullRequestMatch(cacheKey: string): void {
	noPullRequestMatchResource.invalidate(cacheKey);
}

export function makeGitHubPreviewCacheKey({
	worktreePath,
	repoNameWithOwner,
	branchName,
	headSha,
	pullRequestNumber,
}: {
	worktreePath: string;
	repoNameWithOwner: string;
	branchName: string;
	headSha?: string;
	pullRequestNumber?: number | null;
}): string {
	return `${makeGitHubPreviewCachePrefix(worktreePath)}${repoNameWithOwner}::${branchName}::${headSha ?? "no-head"}::pr-${pullRequestNumber ?? "none"}`;
}

export function getCachedGitHubPreviewUrl(cacheKey: string): string | null {
	const cachedState = previewUrlResource.getState(cacheKey);
	const cached = cachedState?.isFresh ? cachedState.value : null;
	recordGitHubCacheMetric({
		kind: "preview",
		event: cachedState?.isFresh ? "fresh_hit" : "miss",
		worktreePath: extractWorktreePathFromCacheKey(cacheKey),
	});
	return cached;
}

export function readCachedGitHubPreviewUrl(
	cacheKey: string,
	load: () => Promise<string | null>,
	options?: CachedResourceReadOptions<string | null>,
): Promise<string | null> {
	const worktreePath = extractWorktreePathFromCacheKey(cacheKey);
	const cached = previewUrlResource.getState(cacheKey);
	recordGitHubCacheMetric({
		kind: "preview",
		event: options?.forceFresh
			? "force_fresh"
			: cached?.isFresh
				? "fresh_hit"
				: cached
					? "stale_hit"
					: "miss",
		worktreePath,
	});

	return previewUrlResource.read(cacheKey, load, {
		...options,
		// Cache misses too so preview-less branches don't repeatedly hit deployments.
		shouldCache:
			options?.shouldCache ??
			(() => {
				recordGitHubCacheMetric({
					kind: "preview",
					event: "write",
					worktreePath,
				});
				return true;
			}),
	});
}

export function getCachedRepoContext(worktreePath: string): RepoContext | null {
	return repoContextResource.get(worktreePath);
}

export function getCachedRepoContextState(
	worktreePath: string,
): CacheState<RepoContext | null> | null {
	return repoContextResource.getState(worktreePath);
}

export function setCachedRepoContext(
	worktreePath: string,
	value: RepoContext,
): void {
	repoContextResource.set(worktreePath, value);
}

export function readCachedRepoContext(
	worktreePath: string,
	load: () => Promise<RepoContext | null>,
	options?: CachedResourceReadOptions<RepoContext | null>,
): Promise<RepoContext | null> {
	return repoContextResource.read(worktreePath, load, {
		...options,
		shouldCache: options?.shouldCache ?? ((value) => value !== null),
	});
}

export function makeGitHubCommitAuthorCacheKey({
	repoNameWithOwner,
	commitHash,
}: {
	repoNameWithOwner: string;
	commitHash: string;
}): string {
	return `${repoNameWithOwner}#${commitHash}`;
}

export function readCachedGitHubCommitAuthor(
	cacheKey: string,
	load: () => Promise<GitHubCommitAuthor | null>,
	options?: CachedResourceReadOptions<GitHubCommitAuthor | null>,
): Promise<GitHubCommitAuthor | null> {
	return commitAuthorResource.read(cacheKey, load, options);
}

export function clearGitHubCachesForWorktree(worktreePath: string): void {
	githubStatusResource.invalidate(worktreePath);
	repoContextResource.invalidate(worktreePath);
	recordGitHubCacheMetric({
		kind: "status",
		event: "invalidate",
		worktreePath,
	});
	previewUrlResource.invalidatePrefix(
		makeGitHubPreviewCachePrefix(worktreePath),
	);
	recordGitHubCacheMetric({
		kind: "preview",
		event: "invalidate",
		worktreePath,
	});
	pullRequestCommentsResource.invalidatePrefix(
		makePullRequestCommentsCachePrefix(worktreePath),
	);
	noPullRequestMatchResource.invalidatePrefix(
		makeGitHubNoPullRequestCachePrefix(worktreePath),
	);
	recordGitHubCacheMetric({
		kind: "comments",
		event: "invalidate",
		worktreePath,
	});
}

function extractWorktreePathFromCacheKey(cacheKey: string): string | null {
	const commentsSeparator = "::comments::";
	const previewSeparator = "::preview::";

	if (cacheKey.includes(commentsSeparator)) {
		return cacheKey.split(commentsSeparator)[0] || null;
	}

	if (cacheKey.includes(previewSeparator)) {
		return cacheKey.split(previewSeparator)[0] || null;
	}

	return cacheKey || null;
}

// GitHub commit author cache (for git-blame avatar resolution)
export interface GitHubCommitAuthor {
	login: string;
	avatarUrl: string;
}

const commitAuthorResource = createCachedResource<GitHubCommitAuthor>({
	name: "github-commit-author",
	ttlMs: 24 * 60 * 60 * 1000, // 24 hours
	maxKeys: 500,
});

export function makeGitHubCommitAuthorCacheKey({
	repoNameWithOwner,
	commitHash,
}: {
	repoNameWithOwner: string;
	commitHash: string;
}): string {
	return `${repoNameWithOwner}:${commitHash}`;
}

export function readCachedGitHubCommitAuthor(
	cacheKey: string,
	load: () => Promise<GitHubCommitAuthor | null>,
	options?: CachedResourceReadOptions<GitHubCommitAuthor | null>,
): Promise<GitHubCommitAuthor | null> {
	return commitAuthorResource.read(cacheKey, load, {
		...options,
		shouldCache: options?.shouldCache ?? ((value) => value !== null),
	});
}
