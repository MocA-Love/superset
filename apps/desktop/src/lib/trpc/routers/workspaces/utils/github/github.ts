import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import {
	branchExistsOnRemote,
	getCurrentBranch,
	isUnbornHeadError,
} from "../git";
import { execGitWithShellPath, getSimpleGitWithShellPath } from "../git-client";
import { execWithShellEnv } from "../shell-env";
import { parseUpstreamRef } from "../upstream-ref";
import {
	clearGitHubCachesForWorktree,
	getCachedGitHubPreviewUrl,
	getCachedGitHubStatus,
	getCachedGitHubStatusState,
	getCachedPullRequestCommentsState,
	makeGitHubPreviewCacheKey,
	makePullRequestCommentsCacheKey,
	readCachedGitHubPreviewUrl,
	readCachedGitHubStatus,
	readCachedPullRequestComments,
} from "./cache";
import { fetchPullRequestComments, resolveReviewThread } from "./comments";
import {
	trackGitHubOperation,
	trackGitHubOperationEvent,
} from "./github-metrics";
import {
	isRateLimited,
	isSecondaryRateLimitError,
	onRateLimitHit,
	onRateLimitSuccess,
} from "./github-rate-limiter";
import {
	canAttachPullRequestToWorkspace,
	type GitRemoteInfo,
} from "./pr-attachment";
import { getPRForBranch } from "./pr-resolution";
import { extractNwoFromUrl, getRepoContext } from "./repo-context";
import {
	GHDeploymentSchema,
	GHDeploymentStatusSchema,
	GHJobResponseSchema,
	type RepoContext,
} from "./types";

export interface PullRequestCommentsTarget {
	prNumber: number;
	repoContext: Pick<RepoContext, "repoUrl" | "upstreamUrl" | "isFork">;
	prUrl?: string | null;
}

export { clearGitHubCachesForWorktree, resolveReviewThread };

function getPullRequestCommentsRepoNameWithOwner(
	target: PullRequestCommentsTarget,
): string | null {
	const prRepoNameWithOwner = target.prUrl
		? extractNwoFromUrl(target.prUrl)
		: null;
	if (prRepoNameWithOwner) {
		return prRepoNameWithOwner;
	}

	const targetUrl = target.repoContext.isFork
		? target.repoContext.upstreamUrl
		: target.repoContext.repoUrl;

	return extractNwoFromUrl(targetUrl);
}

async function getGitRemoteInfos(
	worktreePath: string,
): Promise<GitRemoteInfo[]> {
	const git = await getSimpleGitWithShellPath(worktreePath);
	const remotes = await git.getRemotes(true);
	return remotes.map((remote) => ({
		name: remote.name,
		fetchUrl: remote.refs.fetch,
		pushUrl: remote.refs.push,
	}));
}

async function resolveAttachedPullRequest({
	worktreePath,
	localBranch,
	repoContext,
	headSha,
	fallbackRemote,
}: {
	worktreePath: string;
	localBranch: string;
	repoContext: RepoContext;
	headSha?: string;
	fallbackRemote: string;
}): Promise<GitHubStatus["pr"]> {
	const prInfo = await getPRForBranch(
		worktreePath,
		localBranch,
		repoContext,
		headSha,
	);
	if (!prInfo) {
		return null;
	}

	const remotes = await getGitRemoteInfos(worktreePath);
	return canAttachPullRequestToWorkspace({
		pr: prInfo,
		remotes,
		fallbackRemote,
	})
		? prInfo
		: null;
}

async function resolvePullRequestCommentsTarget(
	worktreePath: string,
): Promise<PullRequestCommentsTarget | null> {
	const githubStatus = await fetchGitHubPRStatus(worktreePath);
	if (!githubStatus?.pr) {
		return null;
	}

	return {
		prNumber: githubStatus.pr.number,
		repoContext: {
			repoUrl: githubStatus.repoUrl,
			upstreamUrl: githubStatus.upstreamUrl ?? githubStatus.repoUrl,
			isFork: githubStatus.isFork ?? false,
		},
		prUrl: githubStatus.pr.url,
	};
}

export function resolveRemoteBranchNameForGitHubStatus({
	localBranchName,
	upstreamBranchName,
	prHeadRefName,
}: {
	localBranchName: string;
	upstreamBranchName?: string | null;
	prHeadRefName?: string | null;
}): string {
	return upstreamBranchName?.trim() || prHeadRefName?.trim() || localBranchName;
}

interface ResolvedGitHubStatusContext {
	repoContext: RepoContext;
	branchName: string;
	headSha?: string;
	trackingRemote: string;
	previewBranchName: string;
	parsedUpstreamBranchName?: string | null;
}

async function resolveGitHubStatusContext(
	worktreePath: string,
): Promise<ResolvedGitHubStatusContext | null> {
	const repoContext = await getRepoContext(worktreePath);
	if (!repoContext) {
		return null;
	}

	const branchName = await getCurrentBranch(worktreePath);
	if (!branchName) {
		return null;
	}

	const [shaResult, upstreamResult] = await Promise.all([
		execGitWithShellPath(["rev-parse", "HEAD"], {
			cwd: worktreePath,
		}).catch((error) => {
			if (isUnbornHeadError(error)) {
				return { stdout: "", stderr: "" };
			}
			throw error;
		}),
		execGitWithShellPath(["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: worktreePath,
		}).catch(() => ({ stdout: "", stderr: "" })),
	]);

	const headSha = shaResult.stdout.trim() || undefined;
	const parsedUpstreamRef = parseUpstreamRef(upstreamResult.stdout.trim());

	return {
		repoContext,
		branchName,
		headSha,
		trackingRemote: parsedUpstreamRef?.remoteName ?? "origin",
		previewBranchName: resolveRemoteBranchNameForGitHubStatus({
			localBranchName: branchName,
			upstreamBranchName: parsedUpstreamRef?.branchName,
		}),
		parsedUpstreamBranchName: parsedUpstreamRef?.branchName,
	};
}

async function refreshGitHubPRStatus(
	worktreePath: string,
): Promise<GitHubStatus | null> {
	try {
		const context = await resolveGitHubStatusContext(worktreePath);
		if (!context) {
			return null;
		}

		const prInfo = await resolveAttachedPullRequest({
			worktreePath,
			localBranch: context.branchName,
			repoContext: context.repoContext,
			headSha: context.headSha,
			fallbackRemote: context.trackingRemote,
		});

		const remoteBranchName = resolveRemoteBranchNameForGitHubStatus({
			localBranchName: context.branchName,
			upstreamBranchName: context.parsedUpstreamBranchName,
			prHeadRefName: prInfo?.headRefName,
		});

		const branchCheck = await branchExistsOnRemote(
			worktreePath,
			remoteBranchName,
			context.trackingRemote,
		);

		return {
			pr: prInfo,
			repoUrl: context.repoContext.repoUrl,
			upstreamUrl: context.repoContext.upstreamUrl,
			isFork: context.repoContext.isFork,
			branchExistsOnRemote: branchCheck.status === "exists",
			lastRefreshed: Date.now(),
		};
	} catch {
		return null;
	}
}

async function refreshGitHubPRComments({
	worktreePath,
	repoNameWithOwner,
	pullRequestNumber,
}: {
	worktreePath: string;
	repoNameWithOwner: string;
	pullRequestNumber: number;
}): Promise<PullRequestComment[]> {
	return fetchPullRequestComments({
		worktreePath,
		repoNameWithOwner,
		pullRequestNumber,
	});
}

/**
 * Fetches GitHub PR status for a worktree using the `gh` CLI.
 * Returns null if `gh` is not installed, not authenticated, or on error.
 */
export async function fetchGitHubPRStatus(
	worktreePath: string,
): Promise<GitHubStatus | null> {
	if (isRateLimited()) {
		// When rate limited, return stale cache or null — never throw,
		// and never overwrite stale cache with null
		const cached = getCachedGitHubStatus(worktreePath);
		trackGitHubOperationEvent({
			name: "status_refresh",
			category: "sync",
			worktreePath,
			success:
				cached !== null || getCachedGitHubStatusState(worktreePath) !== null,
			durationMs: 0,
			rateLimited: true,
			error:
				cached === null && getCachedGitHubStatusState(worktreePath) === null
					? "Rate limited without cached status"
					: undefined,
		});
		return cached;
	}
	return trackGitHubOperation({
		name: "status_refresh",
		category: "sync",
		worktreePath,
		fn: () =>
			readCachedGitHubStatus(worktreePath, () =>
				rateLimitedRefresh(() => refreshGitHubPRStatus(worktreePath)),
			),
	});
}

async function rateLimitedRefresh<T>(fn: () => Promise<T>): Promise<T> {
	try {
		const result = await fn();
		onRateLimitSuccess();
		return result;
	} catch (error) {
		if (isSecondaryRateLimitError(error)) {
			onRateLimitHit();
		}
		throw error;
	}
}

export async function fetchGitHubPRComments({
	worktreePath,
	pullRequest,
}: {
	worktreePath: string;
	pullRequest?: PullRequestCommentsTarget | null;
}): Promise<PullRequestComment[]> {
	if (isRateLimited()) {
		trackGitHubOperationEvent({
			name: "comments_refresh",
			category: "sync",
			worktreePath,
			success: true,
			durationMs: 0,
			rateLimited: true,
		});
		return [];
	}
	try {
		return await trackGitHubOperation({
			name: "comments_refresh",
			category: "sync",
			worktreePath,
			fn: async () => {
				const pullRequestTarget =
					pullRequest ?? (await resolvePullRequestCommentsTarget(worktreePath));
				if (!pullRequestTarget) {
					return [];
				}

				const repoNameWithOwner =
					getPullRequestCommentsRepoNameWithOwner(pullRequestTarget);
				if (!repoNameWithOwner) {
					return [];
				}

				const cacheKey = makePullRequestCommentsCacheKey({
					worktreePath,
					repoNameWithOwner,
					pullRequestNumber: pullRequestTarget.prNumber,
				});
				try {
					return await readCachedPullRequestComments(cacheKey, () =>
						rateLimitedRefresh(() =>
							refreshGitHubPRComments({
								worktreePath,
								repoNameWithOwner,
								pullRequestNumber: pullRequestTarget.prNumber,
							}),
						),
					);
				} catch (error) {
					const cached = getCachedPullRequestCommentsState(cacheKey);
					if (cached) {
						console.warn(
							"[GitHub] Failed to refresh pull request comments; using cached value:",
							error,
						);
						return cached.value;
					}

					throw error;
				}
			},
		});
	} catch {
		return [];
	}
}

export async function fetchGitHubPreviewUrl({
	worktreePath,
	githubStatus,
	forceFresh = false,
}: {
	worktreePath: string;
	githubStatus?: GitHubStatus | null;
	forceFresh?: boolean;
}): Promise<string | null> {
	const context = await resolveGitHubStatusContext(worktreePath);
	if (!context) {
		return null;
	}

	const targetUrl = context.repoContext.isFork
		? context.repoContext.upstreamUrl
		: context.repoContext.repoUrl;
	const repoNameWithOwner = extractNwoFromUrl(targetUrl);
	if (!repoNameWithOwner) {
		return null;
	}

	const cacheKey = makeGitHubPreviewCacheKey({
		worktreePath,
		repoNameWithOwner,
		branchName: context.previewBranchName,
		headSha: context.headSha,
		pullRequestNumber: githubStatus?.pr?.number,
	});

	if (isRateLimited()) {
		const cached = getCachedGitHubPreviewUrl(cacheKey);
		trackGitHubOperationEvent({
			name: "preview_refresh",
			category: "sync",
			worktreePath,
			success: true,
			durationMs: 0,
			rateLimited: true,
		});
		return cached;
	}

	return trackGitHubOperation({
		name: "preview_refresh",
		category: "sync",
		worktreePath,
		fn: async () => {
			return readCachedGitHubPreviewUrl(
				cacheKey,
				() =>
					rateLimitedRefresh(() =>
						refreshGitHubPreviewUrl({
							worktreePath,
							repoNameWithOwner,
							branchName: context.previewBranchName,
							headSha: context.headSha,
							pullRequestNumber: githubStatus?.pr?.number,
						}),
					),
				{
					forceFresh,
				},
			);
		},
	});
}

function isSafeHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Low-level helper: query deployments matching the given params and return
 * the environment_url of the first successful deployment. Status lookups
 * are parallelized to minimize latency.
 */
async function queryDeploymentUrl(
	worktreePath: string,
	nwo: string,
	queryParams: string,
): Promise<string | undefined> {
	const { stdout } = await trackGitHubOperation({
		name: "gh_api_deployments",
		category: "gh",
		worktreePath,
		fn: () =>
			execWithShellEnv(
				"gh",
				["api", `repos/${nwo}/deployments?${queryParams}&per_page=5`],
				{ cwd: worktreePath },
			),
	});

	const rawDeployments: unknown = JSON.parse(stdout.trim());
	if (!Array.isArray(rawDeployments) || rawDeployments.length === 0) {
		return undefined;
	}

	const deploymentIds: number[] = [];
	for (const raw of rawDeployments) {
		const result = GHDeploymentSchema.safeParse(raw);
		if (result.success) {
			deploymentIds.push(result.data.id);
		}
	}
	if (deploymentIds.length === 0) {
		return undefined;
	}

	const urls = await Promise.all(
		deploymentIds.map(async (id): Promise<string | undefined> => {
			try {
				const { stdout: out } = await trackGitHubOperation({
					name: "gh_api_deployment_status",
					category: "gh",
					worktreePath,
					fn: () =>
						execWithShellEnv(
							"gh",
							["api", `repos/${nwo}/deployments/${id}/statuses?per_page=1`],
							{ cwd: worktreePath },
						),
				});
				const rawStatuses: unknown = JSON.parse(out.trim());
				if (!Array.isArray(rawStatuses) || rawStatuses.length === 0) {
					return undefined;
				}
				const statusResult = GHDeploymentStatusSchema.safeParse(rawStatuses[0]);
				if (!statusResult.success) {
					return undefined;
				}
				if (
					statusResult.data.state === "success" &&
					statusResult.data.environment_url &&
					isSafeHttpUrl(statusResult.data.environment_url)
				) {
					return statusResult.data.environment_url;
				}
				return undefined;
			} catch {
				return undefined;
			}
		}),
	);

	// Return the first successful URL (preserves deployment order: most recent first)
	return urls.find((url): url is string => url !== undefined);
}

/**
 * Fetches the preview deployment URL by trying multiple query strategies:
 * 1. By commit SHA (works for Vercel, Netlify official integrations)
 * 2. By branch name ref (works for some CI configurations)
 * 3. By PR merge ref when the PR number is already known
 */
async function refreshGitHubPreviewUrl({
	worktreePath,
	repoNameWithOwner,
	headSha,
	branchName,
	pullRequestNumber,
}: {
	worktreePath: string;
	repoNameWithOwner: string;
	headSha?: string;
	branchName: string;
	pullRequestNumber?: number;
}): Promise<string | null> {
	try {
		if (headSha) {
			const bySha = await queryDeploymentUrl(
				worktreePath,
				repoNameWithOwner,
				`sha=${headSha}`,
			);
			if (bySha) {
				return bySha;
			}
		}

		const byBranch = await queryDeploymentUrl(
			worktreePath,
			repoNameWithOwner,
			`ref=${encodeURIComponent(branchName)}`,
		);
		if (byBranch) {
			return byBranch;
		}

		if (!pullRequestNumber) {
			return null;
		}

		return (
			(await queryDeploymentUrl(
				worktreePath,
				repoNameWithOwner,
				`ref=${encodeURIComponent(`refs/pull/${pullRequestNumber}/merge`)}`,
			)) ?? null
		);
	} catch {
		return null;
	}
}

export interface JobStepInfo {
	name: string;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	number: number;
}

/**
 * Extracts job ID from a GitHub Actions details URL.
 * URL format: https://github.com/{owner}/{repo}/actions/runs/{run_id}/job/{job_id}
 */
function parseJobIdFromUrl(detailsUrl: string): string | null {
	try {
		const url = new URL(detailsUrl);
		const match = url.pathname.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * Extracts nwo (owner/repo) from a GitHub Actions details URL.
 */
function parseNwoFromActionsUrl(detailsUrl: string): string | null {
	try {
		const url = new URL(detailsUrl);
		const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\//);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetches job steps for a given GitHub Actions check using its details URL.
 */
export async function fetchCheckJobSteps(
	worktreePath: string,
	detailsUrl: string,
): Promise<JobStepInfo[]> {
	const jobId = parseJobIdFromUrl(detailsUrl);
	const nwo = parseNwoFromActionsUrl(detailsUrl);
	if (!jobId || !nwo) {
		return [];
	}

	try {
		const { stdout } = await trackGitHubOperation({
			name: "gh_api_actions_job",
			category: "gh",
			worktreePath,
			fn: () =>
				execWithShellEnv("gh", ["api", `repos/${nwo}/actions/jobs/${jobId}`], {
					cwd: worktreePath,
				}),
		});

		const raw: unknown = JSON.parse(stdout.trim());
		const result = GHJobResponseSchema.safeParse(raw);
		if (!result.success) {
			return [];
		}

		return (result.data.steps ?? []).map((step) => ({
			name: step.name,
			status: step.status,
			conclusion: step.conclusion ?? null,
			number: step.number,
		}));
	} catch {
		return [];
	}
}

export interface StructuredJobStep {
	name: string;
	number: number;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	durationSeconds: number | null;
	logs: string;
}

export interface StructuredJobResult {
	jobStatus: "queued" | "in_progress" | "completed" | "waiting";
	jobConclusion: string | null;
	steps: StructuredJobStep[];
}

/**
 * Fetches job step metadata and logs, returning structured per-step data.
 */
export async function fetchStructuredJobLogs(
	worktreePath: string,
	detailsUrl: string,
): Promise<StructuredJobResult> {
	const jobId = parseJobIdFromUrl(detailsUrl);
	const nwo = parseNwoFromActionsUrl(detailsUrl);
	const emptyResult: StructuredJobResult = {
		jobStatus: "queued",
		jobConclusion: null,
		steps: [],
	};
	if (!jobId || !nwo) {
		return emptyResult;
	}

	try {
		// Always fetch job metadata; logs may 404 for in-progress jobs
		const jobResult = await trackGitHubOperation({
			name: "gh_api_actions_job",
			category: "gh",
			worktreePath,
			fn: () =>
				execWithShellEnv("gh", ["api", `repos/${nwo}/actions/jobs/${jobId}`], {
					cwd: worktreePath,
				}),
		});

		const raw: unknown = JSON.parse(jobResult.stdout.trim());
		const result = GHJobResponseSchema.safeParse(raw);
		if (!result.success || !result.data.steps) {
			return emptyResult;
		}

		const jobData = result.data;
		const steps = jobData.steps ?? [];
		const jobCompleted = jobData.status === "completed";

		// Only fetch logs if job is completed (API returns 404 for in-progress)
		let rawLogs = "";
		if (jobCompleted) {
			try {
				const logsResult = await trackGitHubOperation({
					name: "gh_api_actions_job_logs",
					category: "gh",
					worktreePath,
					fn: () =>
						execWithShellEnv(
							"gh",
							["api", `repos/${nwo}/actions/jobs/${jobId}/logs`],
							{ cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
						),
				});
				rawLogs = logsResult.stdout;
			} catch {
				// Logs not yet available
			}
		}

		// Parse raw logs into per-step sections.
		// GitHub log format: each line starts with a timestamp like "2024-01-01T00:00:00.0000000Z "
		// Steps are separated by ##[group] / ##[endgroup] markers, but these aren't always reliable.
		// Instead, match by step started_at/completed_at time ranges.
		const logLines = rawLogs.split("\n");
		const stepLogs: Map<number, string[]> = new Map();

		// Build time ranges for each step
		const stepRanges = steps.map((step) => ({
			number: step.number,
			start: step.started_at ? new Date(step.started_at).getTime() : 0,
			end: step.completed_at
				? new Date(step.completed_at).getTime()
				: Number.POSITIVE_INFINITY,
		}));

		for (const line of logLines) {
			const tsMatch = line.match(
				/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/,
			);
			if (!tsMatch) continue;
			const lineTime = new Date(tsMatch[1]).getTime();
			const lineContent = line.slice(tsMatch[0].length);

			// Find which step this line belongs to
			for (const range of stepRanges) {
				if (lineTime >= range.start && lineTime <= range.end + 1000) {
					if (!stepLogs.has(range.number)) {
						stepLogs.set(range.number, []);
					}
					stepLogs.get(range.number)?.push(lineContent);
					break;
				}
			}
		}

		return {
			jobStatus: jobData.status,
			jobConclusion: jobData.conclusion ?? null,
			steps: steps.map((step) => {
				let durationSeconds: number | null = null;
				if (step.started_at && step.completed_at) {
					durationSeconds = Math.round(
						(new Date(step.completed_at).getTime() -
							new Date(step.started_at).getTime()) /
							1000,
					);
				}
				return {
					name: step.name,
					number: step.number,
					status: step.status,
					conclusion: step.conclusion ?? null,
					durationSeconds,
					logs: stepLogs.get(step.number)?.join("\n") ?? "",
				};
			}),
		};
	} catch (err) {
		console.error("[fetchStructuredJobLogs] Failed:", err);
		return emptyResult;
	}
}

export interface JobStatusInfo {
	detailsUrl: string;
	status: "queued" | "in_progress" | "completed" | "waiting";
	conclusion: string | null;
}

/**
 * Fetches current status for multiple jobs in parallel.
 */
export async function fetchJobStatuses(
	worktreePath: string,
	detailsUrls: string[],
): Promise<JobStatusInfo[]> {
	const results = await Promise.allSettled(
		detailsUrls.map(async (detailsUrl) => {
			const jobId = parseJobIdFromUrl(detailsUrl);
			const nwo = parseNwoFromActionsUrl(detailsUrl);
			if (!jobId || !nwo) {
				return { detailsUrl, status: "queued" as const, conclusion: null };
			}
			const { stdout } = await trackGitHubOperation({
				name: "gh_api_actions_job_status",
				category: "gh",
				worktreePath,
				fn: () =>
					execWithShellEnv(
						"gh",
						[
							"api",
							`repos/${nwo}/actions/jobs/${jobId}`,
							"--jq",
							'.status + "|" + (.conclusion // "")',
						],
						{ cwd: worktreePath },
					),
			});
			const [status, conclusion] = stdout.trim().split("|");
			return {
				detailsUrl,
				status: (status || "queued") as JobStatusInfo["status"],
				conclusion: conclusion || null,
			};
		}),
	);
	return results.map((r, i) =>
		r.status === "fulfilled"
			? r.value
			: {
					detailsUrl: detailsUrls[i],
					status: "queued" as const,
					conclusion: null,
				},
	);
}
