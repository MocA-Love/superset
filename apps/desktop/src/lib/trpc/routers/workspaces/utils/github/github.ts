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
	getCachedPullRequestCommentsState,
	makePullRequestCommentsCacheKey,
	readCachedGitHubStatus,
	readCachedPullRequestComments,
} from "./cache";
import { fetchPullRequestComments, resolveReviewThread } from "./comments";
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

async function refreshGitHubPRStatus(
	worktreePath: string,
): Promise<GitHubStatus | null> {
	try {
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
		const trackingRemote = parsedUpstreamRef?.remoteName ?? "origin";
		const previewBranchName = resolveRemoteBranchNameForGitHubStatus({
			localBranchName: branchName,
			upstreamBranchName: parsedUpstreamRef?.branchName,
		});

		const [prInfo, previewUrl] = await Promise.all([
			resolveAttachedPullRequest({
				worktreePath,
				localBranch: branchName,
				repoContext,
				headSha,
				fallbackRemote: trackingRemote,
			}),
			fetchPreviewDeploymentUrl(
				worktreePath,
				headSha,
				previewBranchName,
				repoContext,
			),
		]);

		const remoteBranchName = resolveRemoteBranchNameForGitHubStatus({
			localBranchName: branchName,
			upstreamBranchName: parsedUpstreamRef?.branchName,
			prHeadRefName: prInfo?.headRefName,
		});

		const branchCheck = await branchExistsOnRemote(
			worktreePath,
			remoteBranchName,
			trackingRemote,
		);

		let finalPreviewUrl = previewUrl;
		if (!finalPreviewUrl && prInfo?.number) {
			const targetUrl = repoContext.isFork
				? repoContext.upstreamUrl
				: repoContext.repoUrl;
			const nwo = extractNwoFromUrl(targetUrl);
			if (nwo) {
				finalPreviewUrl = await queryDeploymentUrl(
					worktreePath,
					nwo,
					`ref=${encodeURIComponent(`refs/pull/${prInfo.number}/merge`)}`,
				);
			}
		}

		const result: GitHubStatus = {
			pr: prInfo,
			repoUrl: repoContext.repoUrl,
			upstreamUrl: repoContext.upstreamUrl,
			isFork: repoContext.isFork,
			branchExistsOnRemote: branchCheck.status === "exists",
			previewUrl: finalPreviewUrl,
			lastRefreshed: Date.now(),
		};

		return result;
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
	return readCachedGitHubStatus(worktreePath, () =>
		refreshGitHubPRStatus(worktreePath),
	);
}

export async function fetchGitHubPRComments({
	worktreePath,
	pullRequest,
}: {
	worktreePath: string;
	pullRequest?: PullRequestCommentsTarget | null;
}): Promise<PullRequestComment[]> {
	try {
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
				refreshGitHubPRComments({
					worktreePath,
					repoNameWithOwner,
					pullRequestNumber: pullRequestTarget.prNumber,
				}),
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
	} catch {
		return [];
	}
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
	const { stdout } = await execWithShellEnv(
		"gh",
		["api", `repos/${nwo}/deployments?${queryParams}&per_page=5`],
		{ cwd: worktreePath },
	);

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
				const { stdout: out } = await execWithShellEnv(
					"gh",
					["api", `repos/${nwo}/deployments/${id}/statuses?per_page=1`],
					{ cwd: worktreePath },
				);
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
 * The PR merge ref (refs/pull/N/merge) is handled in fetchGitHubPRStatus
 * after the PR number is known.
 */
async function fetchPreviewDeploymentUrl(
	worktreePath: string,
	headSha: string | undefined,
	branchName: string,
	repoContext: RepoContext,
): Promise<string | undefined> {
	try {
		const targetUrl = repoContext.isFork
			? repoContext.upstreamUrl
			: repoContext.repoUrl;
		const nwo = extractNwoFromUrl(targetUrl);
		if (!nwo) {
			return undefined;
		}

		if (headSha) {
			// Try by commit SHA (works for Vercel, Netlify official integrations)
			const bySha = await queryDeploymentUrl(
				worktreePath,
				nwo,
				`sha=${headSha}`,
			);
			if (bySha) {
				return bySha;
			}
		}

		// Fall back to branch name (works for some CI configurations)
		return await queryDeploymentUrl(
			worktreePath,
			nwo,
			`ref=${encodeURIComponent(branchName)}`,
		);
	} catch {
		return undefined;
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
		const { stdout } = await execWithShellEnv(
			"gh",
			["api", `repos/${nwo}/actions/jobs/${jobId}`],
			{ cwd: worktreePath },
		);

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
		const jobResult = await execWithShellEnv(
			"gh",
			["api", `repos/${nwo}/actions/jobs/${jobId}`],
			{ cwd: worktreePath },
		);

		const raw: unknown = JSON.parse(jobResult.stdout.trim());
		const result = GHJobResponseSchema.safeParse(raw);
		if (!result.success || !result.data.steps) {
			return emptyResult;
		}

		const jobData = result.data;
		const steps = jobData.steps;
		const jobCompleted = jobData.status === "completed";

		// Only fetch logs if job is completed (API returns 404 for in-progress)
		let rawLogs = "";
		if (jobCompleted) {
			try {
				const logsResult = await execWithShellEnv(
					"gh",
					["api", `repos/${nwo}/actions/jobs/${jobId}/logs`],
					{ cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
				);
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
			const { stdout } = await execWithShellEnv(
				"gh",
				[
					"api",
					`repos/${nwo}/actions/jobs/${jobId}`,
					"--jq",
					'.status + "|" + (.conclusion // "")',
				],
				{ cwd: worktreePath },
			);
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
