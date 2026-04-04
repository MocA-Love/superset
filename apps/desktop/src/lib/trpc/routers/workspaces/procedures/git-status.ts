import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GitHubStatus } from "@superset/local-db";
import { workspaces, worktrees } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import yaml from "js-yaml";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../../..";
import {
	getProject,
	getWorkspace,
	getWorktree,
	updateProjectDefaultBranch,
} from "../utils/db-helpers";
import {
	branchExistsOnRemote,
	fetchDefaultBranch,
	getAheadBehindCount,
	getCurrentBranch,
	getDefaultBranch,
	listExternalWorktrees,
	refreshDefaultBranch,
} from "../utils/git";
import {
	clearGitHubCachesForWorktree,
	extractNwoFromUrl,
	fetchCheckJobSteps,
	fetchGitHubPRComments,
	fetchGitHubPRStatus,
	fetchJobStatuses,
	fetchStructuredJobLogs,
	getRepoContext,
	type PullRequestCommentsTarget,
} from "../utils/github";
import { GHIdentityCandidatesResponseSchema } from "../utils/github/types";
import { execWithShellEnv } from "../utils/shell-env";

const gitHubPRCommentsInputSchema = z.object({
	workspaceId: z.string(),
	prNumber: z.number().int().positive().optional(),
	prUrl: z.string().optional(),
	repoUrl: z.string().optional(),
	upstreamUrl: z.string().optional(),
	isFork: z.boolean().optional(),
	forceFresh: z.boolean().optional(),
});

const ghRepositoryPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	isDraft: z.boolean().optional().default(false),
	headRefName: z.string().optional(),
	updatedAt: z.string().nullable().optional(),
	author: z
		.object({
			login: z.string().optional(),
		})
		.nullable()
		.optional(),
});

const ghRepositoryWorkflowSchema = z.object({
	id: z.number(),
	name: z.string(),
	path: z.string().optional(),
	state: z.string().optional(),
});

const ghRepositoryWorkflowsResponseSchema = z.object({
	workflows: z.array(ghRepositoryWorkflowSchema).optional(),
});

const ghRepositoryWorkflowRunSchema = z.object({
	id: z.number(),
	name: z.string().nullable().optional(),
	display_title: z.string().nullable().optional(),
	html_url: z.string().optional(),
	status: z.string().nullable().optional(),
	conclusion: z.string().nullable().optional(),
	event: z.string().nullable().optional(),
	created_at: z.string().nullable().optional(),
	updated_at: z.string().nullable().optional(),
	run_started_at: z.string().nullable().optional(),
	head_branch: z.string().nullable().optional(),
	head_sha: z.string().nullable().optional(),
	run_number: z.number().optional(),
	workflow_id: z.number().optional(),
});

const ghRepositoryWorkflowRunsResponseSchema = z.object({
	workflow_runs: z.array(ghRepositoryWorkflowRunSchema).optional(),
});

const ghRepositoryLabelSchema = z.object({
	name: z.string(),
	color: z.string().optional(),
	description: z.string().nullable().optional(),
});

const ghRepositoryAssigneeSchema = z.object({
	login: z.string(),
	avatar_url: z.string().optional(),
});

function sanitizeIssueAssetBasename(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
}

function getIssueAssetExtension({
	filename,
	mimeType,
}: {
	filename?: string;
	mimeType?: string;
}): string {
	const lower = filename?.toLowerCase() ?? "";
	if (lower.endsWith(".png")) return "png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg";
	if (lower.endsWith(".gif")) return "gif";
	if (lower.endsWith(".webp")) return "webp";

	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

async function ensureGitHubBranchExists({
	repoPath,
	repositoryNameWithOwner,
	branchName,
	baseBranch,
}: {
	repoPath: string;
	repositoryNameWithOwner: string;
	branchName: string;
	baseBranch: string;
}) {
	try {
		await execWithShellEnv(
			"gh",
			["api", `repos/${repositoryNameWithOwner}/git/ref/heads/${branchName}`],
			{ cwd: repoPath },
		);
		return;
	} catch (error) {
		const errorText =
			error instanceof Error
				? [
						error.message,
						"stderr" in error && typeof error.stderr === "string"
							? error.stderr
							: "",
						"stdout" in error && typeof error.stdout === "string"
							? error.stdout
							: "",
					]
						.join("\n")
						.toLowerCase()
				: String(error).toLowerCase();
		const isMissingRefError =
			errorText.includes("404") ||
			errorText.includes("not found") ||
			errorText.includes("no ref found");

		if (!isMissingRefError) {
			console.warn("[git-status] GitHub branch probe failed", {
				repoPath,
				repositoryNameWithOwner,
				branchName,
				baseBranch,
				error,
			});
			throw error;
		}

		console.warn("[git-status] GitHub branch not found, creating branch", {
			repoPath,
			repositoryNameWithOwner,
			branchName,
			baseBranch,
			error,
		});
	}

	const { stdout } = await execWithShellEnv(
		"gh",
		["api", `repos/${repositoryNameWithOwner}/git/ref/heads/${baseBranch}`],
		{ cwd: repoPath },
	);
	const raw = JSON.parse(stdout) as {
		object?: { sha?: string };
	};
	const sha = raw.object?.sha;
	if (!sha) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Could not determine the base branch SHA for issue assets.",
		});
	}

	await execWithShellEnv(
		"gh",
		[
			"api",
			"--method",
			"POST",
			`repos/${repositoryNameWithOwner}/git/refs`,
			"-f",
			`ref=refs/heads/${branchName}`,
			"-f",
			`sha=${sha}`,
		],
		{ cwd: repoPath },
	);
}

function parseRunIdFromActionsUrl(detailsUrl?: string): string | null {
	if (!detailsUrl) {
		return null;
	}

	try {
		const url = new URL(detailsUrl);
		const match = url.pathname.match(/\/actions\/runs\/(\d+)(?:\/|$)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function isGitHubActionsUrl(url?: string): boolean {
	return parseRunIdFromActionsUrl(url) !== null;
}

interface WorkflowDispatchInput {
	name: string;
	description: string;
	required: boolean;
	default: string;
	type: "string" | "choice" | "boolean" | "number" | "environment";
	options: string[];
}

interface WorkflowDispatchInfo {
	supportsDispatch: boolean;
	inputs: WorkflowDispatchInput[];
}

function parseWorkflowDispatchInfo({
	repoPath,
	workflowPath,
}: {
	repoPath: string;
	workflowPath?: string;
}): WorkflowDispatchInfo {
	const noDispatch: WorkflowDispatchInfo = {
		supportsDispatch: false,
		inputs: [],
	};

	if (!workflowPath) {
		return noDispatch;
	}

	const absolutePath = path.join(repoPath, workflowPath);
	if (!existsSync(absolutePath)) {
		return noDispatch;
	}

	let content: string;
	try {
		content = readFileSync(absolutePath, "utf8");
	} catch {
		return noDispatch;
	}

	const hasDispatch =
		/^\s*workflow_dispatch\s*:/m.test(content) ||
		/^\s*on\s*:\s*workflow_dispatch\s*$/m.test(content) ||
		/^\s*on\s*:\s*\[[^\]]*\bworkflow_dispatch\b[^\]]*\]/m.test(content);

	if (!hasDispatch) {
		return noDispatch;
	}

	try {
		const parsed = yaml.load(content) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") {
			return { supportsDispatch: true, inputs: [] };
		}

		const onBlock = parsed.on ?? parsed.true;
		if (!onBlock || typeof onBlock !== "object") {
			return { supportsDispatch: true, inputs: [] };
		}

		const dispatchBlock = (onBlock as Record<string, unknown>)
			.workflow_dispatch;
		if (!dispatchBlock || typeof dispatchBlock !== "object") {
			return { supportsDispatch: true, inputs: [] };
		}

		const rawInputs = (dispatchBlock as Record<string, unknown>).inputs;
		if (!rawInputs || typeof rawInputs !== "object") {
			return { supportsDispatch: true, inputs: [] };
		}

		const inputs: WorkflowDispatchInput[] = Object.entries(
			rawInputs as Record<string, unknown>,
		).map(([name, value]) => {
			const input = (value ?? {}) as Record<string, unknown>;
			const inputType = String(input.type ?? "string");
			const options: string[] = Array.isArray(input.options)
				? input.options.map(String)
				: [];

			return {
				name,
				description: String(input.description ?? ""),
				required: Boolean(input.required ?? false),
				default: String(input.default ?? ""),
				type: (
					["string", "choice", "boolean", "number", "environment"] as const
				).includes(inputType as never)
					? (inputType as WorkflowDispatchInput["type"])
					: "string",
				options,
			};
		});

		return { supportsDispatch: true, inputs };
	} catch {
		return { supportsDispatch: true, inputs: [] };
	}
}

function resolveCommentsPullRequestTarget({
	input,
	githubStatus,
}: {
	input: z.infer<typeof gitHubPRCommentsInputSchema>;
	githubStatus: GitHubStatus | null | undefined;
}): PullRequestCommentsTarget | null {
	const prNumber = input.prNumber ?? githubStatus?.pr?.number;
	if (!prNumber) {
		return null;
	}

	const repoUrl = input.repoUrl ?? githubStatus?.repoUrl;
	if (!repoUrl) {
		return null;
	}

	const upstreamUrl =
		input.upstreamUrl ?? githubStatus?.upstreamUrl ?? githubStatus?.repoUrl;
	if (!upstreamUrl) {
		return null;
	}

	return {
		prNumber,
		prUrl: input.prUrl ?? githubStatus?.pr?.url,
		repoContext: {
			repoUrl,
			upstreamUrl,
			isFork: input.isFork ?? githubStatus?.isFork ?? false,
		},
	};
}

function stripGitHubStatusTimestamp(
	status: GitHubStatus | null | undefined,
): Omit<GitHubStatus, "lastRefreshed"> | null {
	if (!status) {
		return null;
	}

	const { lastRefreshed: _lastRefreshed, ...rest } = status;
	return rest;
}

function hasMeaningfulGitHubStatusChange({
	current,
	next,
}: {
	current: GitHubStatus | null | undefined;
	next: GitHubStatus | null;
}): boolean {
	return (
		JSON.stringify(stripGitHubStatusTimestamp(current)) !==
		JSON.stringify(stripGitHubStatusTimestamp(next))
	);
}

function resolveRepoPathForWorkspace(workspaceId: string): {
	workspace: NonNullable<ReturnType<typeof getWorkspace>>;
	worktree: NonNullable<ReturnType<typeof getWorktree>> | null;
	repoPath: string;
} {
	const workspace = getWorkspace(workspaceId);
	if (!workspace) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Workspace ${workspaceId} not found`,
		});
	}

	const worktree = workspace.worktreeId
		? (getWorktree(workspace.worktreeId) ?? null)
		: null;
	let repoPath: string | null = worktree?.path ?? null;
	if (!repoPath && workspace.type === "branch") {
		const project = getProject(workspace.projectId);
		repoPath = project?.mainRepoPath ?? null;
	}

	if (!repoPath) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "GitHub is not available for this workspace.",
		});
	}

	return { workspace, worktree, repoPath };
}

async function getFreshPullRequestForWorkspace(workspaceId: string): Promise<{
	repoPath: string;
	worktree: NonNullable<ReturnType<typeof getWorktree>> | null;
	pullRequest: NonNullable<GitHubStatus["pr"]>;
}> {
	const { repoPath, worktree } = resolveRepoPathForWorkspace(workspaceId);
	clearGitHubCachesForWorktree(repoPath);
	const githubStatus = await fetchGitHubPRStatus(repoPath);
	const pullRequest = githubStatus?.pr ?? null;

	if (!pullRequest) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "No pull request found for this workspace.",
		});
	}

	return { repoPath, worktree, pullRequest };
}

async function resolveRepositoryTargetForWorkspace(
	workspaceId: string,
): Promise<{
	repoPath: string;
	worktree: NonNullable<ReturnType<typeof getWorktree>> | null;
	repositoryUrl: string;
	repositoryNameWithOwner: string;
	upstreamUrl: string;
	upstreamNameWithOwner: string;
	isFork: boolean;
	branchExistsOnRemote: boolean;
	currentBranch: string;
	defaultBranch: string;
}> {
	const { repoPath, worktree } = resolveRepoPathForWorkspace(workspaceId);
	const [githubStatus, repoContext, currentBranch, defaultBranch] =
		await Promise.all([
			fetchGitHubPRStatus(repoPath),
			getRepoContext(repoPath),
			getCurrentBranch(repoPath),
			getDefaultBranch(repoPath),
		]);

	const repoUrl = githubStatus?.repoUrl ?? repoContext?.repoUrl;
	const upstreamUrl =
		githubStatus?.upstreamUrl ?? repoContext?.upstreamUrl ?? repoUrl;
	const isFork = githubStatus?.isFork ?? repoContext?.isFork ?? false;
	const repositoryUrl = repoUrl;
	const repositoryNameWithOwner = repositoryUrl
		? extractNwoFromUrl(repositoryUrl)
		: null;
	const upstreamNameWithOwner = upstreamUrl
		? extractNwoFromUrl(upstreamUrl)
		: null;

	if (
		!repoUrl ||
		!upstreamUrl ||
		!repositoryUrl ||
		!repositoryNameWithOwner ||
		!upstreamNameWithOwner
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Could not determine the GitHub repository for this workspace.",
		});
	}

	if (!currentBranch) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Could not determine the current branch for this workspace.",
		});
	}

	return {
		repoPath,
		worktree,
		repositoryUrl,
		repositoryNameWithOwner,
		upstreamUrl,
		upstreamNameWithOwner,
		isFork,
		branchExistsOnRemote: githubStatus?.branchExistsOnRemote ?? false,
		currentBranch,
		defaultBranch,
	};
}

async function getGitHubRepositoryOverview(workspaceId: string) {
	const {
		repoPath,
		repositoryNameWithOwner,
		repositoryUrl,
		upstreamUrl,
		upstreamNameWithOwner,
		isFork,
		branchExistsOnRemote,
		currentBranch,
		defaultBranch,
	} = await resolveRepositoryTargetForWorkspace(workspaceId);

	const [pullRequestsResult, workflowsResult, labelsResult, assigneesResult] =
		await Promise.all([
			execWithShellEnv(
				"gh",
				[
					"pr",
					"list",
					"--repo",
					repositoryNameWithOwner,
					"--state",
					"open",
					"--limit",
					"8",
					"--json",
					"number,title,url,state,isDraft,headRefName,updatedAt,author",
				],
				{ cwd: repoPath },
			),
			execWithShellEnv(
				"gh",
				[
					"api",
					`repos/${repositoryNameWithOwner}/actions/workflows?per_page=100`,
				],
				{ cwd: repoPath },
			),
			execWithShellEnv(
				"gh",
				["api", `repos/${repositoryNameWithOwner}/labels?per_page=100`],
				{ cwd: repoPath },
			),
			execWithShellEnv(
				"gh",
				["api", `repos/${repositoryNameWithOwner}/assignees?per_page=100`],
				{ cwd: repoPath },
			),
		]);

	const rawPullRequests = JSON.parse(pullRequestsResult.stdout) as unknown;
	const pullRequests = z
		.array(ghRepositoryPullRequestSchema)
		.parse(rawPullRequests);

	const rawWorkflows = JSON.parse(workflowsResult.stdout) as unknown;
	const workflows =
		ghRepositoryWorkflowsResponseSchema.parse(rawWorkflows).workflows ?? [];
	const rawLabels = JSON.parse(labelsResult.stdout) as unknown;
	const labels = z.array(ghRepositoryLabelSchema).parse(rawLabels);
	const rawAssignees = JSON.parse(assigneesResult.stdout) as unknown;
	const assignees = z.array(ghRepositoryAssigneeSchema).parse(rawAssignees);

	return {
		repositoryNameWithOwner,
		repositoryUrl,
		upstreamUrl,
		upstreamNameWithOwner,
		isFork,
		branchExistsOnRemote,
		currentBranch,
		defaultBranch,
		issueAssignees: assignees.map((assignee) => ({
			login: assignee.login,
			avatarUrl: assignee.avatar_url ?? null,
		})),
		issueLabels: labels.map((label) => ({
			name: label.name,
			color: label.color ?? "",
			description: label.description ?? "",
		})),
		pullsUrl: `${repositoryUrl}/pulls`,
		issuesUrl: `${repositoryUrl}/issues`,
		actionsUrl: `${repositoryUrl}/actions`,
		newIssueUrl: `${repositoryUrl}/issues/new`,
		pullRequests: pullRequests.map((pullRequest) => ({
			number: pullRequest.number,
			title: pullRequest.title,
			url: pullRequest.url,
			state: pullRequest.isDraft ? "draft" : pullRequest.state.toLowerCase(),
			headRefName: pullRequest.headRefName ?? "",
			updatedAt: pullRequest.updatedAt ?? null,
			authorLogin: pullRequest.author?.login ?? null,
		})),
		workflows: workflows
			.filter((workflow) => workflow.state !== "disabled_manually")
			.map((workflow) => {
				const dispatchInfo = parseWorkflowDispatchInfo({
					repoPath,
					workflowPath: workflow.path,
				});
				return {
					id: workflow.id,
					name: workflow.name,
					path: workflow.path ?? "",
					state: workflow.state ?? "unknown",
					supportsDispatch: dispatchInfo.supportsDispatch,
					inputs: dispatchInfo.inputs,
				};
			})
			.filter((workflow) => workflow.supportsDispatch),
	};
}

async function createGitHubIssueForWorkspace({
	workspaceId,
	title,
	body,
	assignees,
	labels,
}: {
	workspaceId: string;
	title: string;
	body?: string;
	assignees?: string[];
	labels?: string[];
}) {
	const { repoPath, repositoryNameWithOwner } =
		await resolveRepositoryTargetForWorkspace(workspaceId);
	const args = [
		"issue",
		"create",
		"--repo",
		repositoryNameWithOwner,
		"--title",
		title.trim(),
		"--body",
		body?.trim() || "",
	];
	const normalizedAssignees = normalizeIdentityList(assignees ?? []);
	const normalizedLabels = normalizeIdentityList(labels ?? []);
	if (normalizedAssignees.length > 0) {
		args.push("--assignee", normalizedAssignees.join(","));
	}
	if (normalizedLabels.length > 0) {
		args.push("--label", normalizedLabels.join(","));
	}
	const { stdout } = await execWithShellEnv("gh", args, { cwd: repoPath });

	return {
		url: stdout.trim(),
	};
}

async function uploadIssueAssetForWorkspace({
	workspaceId,
	filename,
	contentBase64,
	mimeType,
}: {
	workspaceId: string;
	filename: string;
	contentBase64: string;
	mimeType?: string;
}) {
	const { repoPath, repositoryNameWithOwner, defaultBranch } =
		await resolveRepositoryTargetForWorkspace(workspaceId);
	const assetBranch = "superset-issue-assets";
	await ensureGitHubBranchExists({
		repoPath,
		repositoryNameWithOwner,
		branchName: assetBranch,
		baseBranch: defaultBranch,
	});

	const now = new Date();
	const extension = getIssueAssetExtension({ filename, mimeType });
	const basename =
		sanitizeIssueAssetBasename(filename.replace(/\.[^.]+$/, "")) ||
		"pasted-image";
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const assetPath = [
		".superset",
		"issue-assets",
		String(now.getUTCFullYear()),
		String(now.getUTCMonth() + 1).padStart(2, "0"),
		`${timestamp}-${basename}.${extension}`,
	].join("/");

	await execWithShellEnv(
		"gh",
		[
			"api",
			"--method",
			"PUT",
			`repos/${repositoryNameWithOwner}/contents/${assetPath}`,
			"-f",
			`message=Add issue asset ${assetPath}`,
			"-f",
			`content=${contentBase64}`,
			"-f",
			`branch=${assetBranch}`,
		],
		{ cwd: repoPath },
	);

	const assetUrl = `https://github.com/${repositoryNameWithOwner}/raw/${assetBranch}/${assetPath}`;

	return {
		name: `${basename}.${extension}`,
		url: assetUrl,
		markdown: `![${basename}](${assetUrl})`,
	};
}

async function dispatchGitHubWorkflowForWorkspace({
	workspaceId,
	workflowId,
	ref,
	inputs,
}: {
	workspaceId: string;
	workflowId: number;
	ref?: string;
	inputs?: Record<string, string>;
}) {
	const { repoPath, repositoryNameWithOwner, currentBranch, defaultBranch } =
		await resolveRepositoryTargetForWorkspace(workspaceId);
	const requestedRef = ref?.trim() || currentBranch || defaultBranch;
	let targetRef = requestedRef;
	if (requestedRef === currentBranch) {
		const branchCheck = await branchExistsOnRemote(
			repoPath,
			currentBranch,
			"origin",
		);
		if (branchCheck.status !== "exists") {
			targetRef = defaultBranch;
		}
	}

	const args = [
		"api",
		"--method",
		"POST",
		`repos/${repositoryNameWithOwner}/actions/workflows/${workflowId}/dispatches`,
		"-f",
		`ref=${targetRef}`,
	];

	if (inputs) {
		for (const [key, value] of Object.entries(inputs)) {
			args.push("-f", `inputs[${key}]=${value}`);
		}
	}

	await execWithShellEnv("gh", args, { cwd: repoPath });

	return {
		success: true as const,
		ref: targetRef,
		dispatchedAt: new Date().toISOString(),
	};
}

async function getGitHubWorkflowRunsForWorkspace({
	workspaceId,
	workflowId,
}: {
	workspaceId: string;
	workflowId: number;
}) {
	const { repoPath, repositoryNameWithOwner } =
		await resolveRepositoryTargetForWorkspace(workspaceId);
	const { stdout } = await execWithShellEnv(
		"gh",
		[
			"api",
			`repos/${repositoryNameWithOwner}/actions/workflows/${workflowId}/runs?per_page=10&event=workflow_dispatch`,
		],
		{ cwd: repoPath },
	);

	const rawRuns = JSON.parse(stdout) as unknown;
	const runs =
		ghRepositoryWorkflowRunsResponseSchema.parse(rawRuns).workflow_runs ?? [];

	return runs.map((run) => ({
		id: run.id,
		name: run.name ?? "",
		displayTitle: run.display_title ?? "",
		url: run.html_url ?? "",
		status: run.status ?? "unknown",
		conclusion: run.conclusion ?? null,
		event: run.event ?? null,
		createdAt: run.created_at ?? null,
		updatedAt: run.updated_at ?? null,
		runStartedAt: run.run_started_at ?? null,
		headBranch: run.head_branch ?? null,
		headSha: run.head_sha ?? null,
		runNumber: run.run_number ?? null,
		workflowId: run.workflow_id ?? workflowId,
	}));
}

async function getWorkflowRunJobsForWorkspace({
	workspaceId,
	runId,
}: {
	workspaceId: string;
	runId: number;
}) {
	const { repoPath, repositoryNameWithOwner } =
		await resolveRepositoryTargetForWorkspace(workspaceId);
	const { stdout } = await execWithShellEnv(
		"gh",
		[
			"api",
			`repos/${repositoryNameWithOwner}/actions/runs/${runId}/jobs?per_page=100`,
		],
		{ cwd: repoPath },
	);

	const raw: unknown = JSON.parse(stdout);
	const parsed = z
		.object({
			jobs: z
				.array(
					z.object({
						id: z.number(),
						name: z.string(),
						status: z.string(),
						conclusion: z.string().nullable(),
						html_url: z.string().nullable().optional(),
					}),
				)
				.optional(),
		})
		.parse(raw);

	return (parsed.jobs ?? []).map((job) => ({
		detailsUrl: job.html_url ?? "",
		name: job.name,
		status: mapJobStatus(job.status, job.conclusion),
	}));
}

function mapJobStatus(
	status: string,
	conclusion: string | null,
): "success" | "failure" | "pending" | "skipped" | "cancelled" {
	if (status !== "completed") {
		return "pending";
	}
	switch (conclusion) {
		case "success":
			return "success";
		case "failure":
		case "timed_out":
			return "failure";
		case "cancelled":
			return "cancelled";
		case "skipped":
			return "skipped";
		default:
			return "pending";
	}
}

async function rerunPullRequestChecksForWorkspace({
	workspaceId,
	mode,
}: {
	workspaceId: string;
	mode: "all" | "failed";
}) {
	const { repoPath, worktree, pullRequest } =
		await getFreshPullRequestForWorkspace(workspaceId);
	const checksToRerun = pullRequest.checks.filter((check) => {
		if (!isGitHubActionsUrl(check.url)) {
			return false;
		}

		if (mode === "failed") {
			return check.status === "failure";
		}

		return true;
	});

	if (checksToRerun.length === 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				mode === "failed"
					? "No failed GitHub Actions jobs found for this pull request."
					: "No GitHub Actions jobs found for this pull request.",
		});
	}

	const runTargets = new Map<string, string>();
	for (const check of checksToRerun) {
		const runId = parseRunIdFromActionsUrl(check.url);
		const repositoryNameWithOwner = check.url
			? extractNwoFromUrl(check.url)
			: null;
		if (!runId || !repositoryNameWithOwner) {
			continue;
		}

		runTargets.set(
			`${repositoryNameWithOwner}:${runId}`,
			`${repositoryNameWithOwner}:${runId}`,
		);
	}

	if (runTargets.size === 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "No rerunnable GitHub Actions runs were found.",
		});
	}

	for (const target of runTargets.values()) {
		const [repositoryNameWithOwner, runId] = target.split(":");
		if (!repositoryNameWithOwner || !runId) {
			continue;
		}

		await execWithShellEnv(
			"gh",
			[
				"api",
				"--method",
				"POST",
				`repos/${repositoryNameWithOwner}/actions/runs/${runId}/${mode === "failed" ? "rerun-failed-jobs" : "rerun"}`,
			],
			{ cwd: repoPath },
		);
	}

	clearGitHubCachesForWorktree(repoPath);
	if (worktree) {
		localDb
			.update(worktrees)
			.set({ githubStatus: null })
			.where(eq(worktrees.id, worktree.id))
			.run();
	}

	return {
		success: true as const,
		rerunCount: runTargets.size,
	};
}

function resolvePullRequestTarget({
	workspaceId,
	pullRequestNumber,
	pullRequestUrl,
}: {
	workspaceId: string;
	pullRequestNumber?: number;
	pullRequestUrl?: string;
}): {
	repoPath: string;
	worktree: NonNullable<ReturnType<typeof getWorktree>> | null;
	repoNameWithOwner: string;
	pullRequestNumber: number;
} {
	const { repoPath, worktree } = resolveRepoPathForWorkspace(workspaceId);
	const repoNameWithOwner = pullRequestUrl
		? extractNwoFromUrl(pullRequestUrl)
		: null;

	if (!repoNameWithOwner || !pullRequestNumber) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Could not determine the pull request target.",
		});
	}

	return {
		repoPath,
		worktree,
		repoNameWithOwner,
		pullRequestNumber,
	};
}

function resolvePullRequestRepoTarget({
	workspaceId,
	pullRequestUrl,
}: {
	workspaceId: string;
	pullRequestUrl?: string;
}): {
	repoPath: string;
	worktree: NonNullable<ReturnType<typeof getWorktree>> | null;
	repoNameWithOwner: string;
} {
	const { repoPath, worktree } = resolveRepoPathForWorkspace(workspaceId);
	const repoNameWithOwner = pullRequestUrl
		? extractNwoFromUrl(pullRequestUrl)
		: null;

	if (!repoNameWithOwner) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Could not determine the pull request repository.",
		});
	}

	return {
		repoPath,
		worktree,
		repoNameWithOwner,
	};
}

function normalizeIdentityList(values: string[]): string[] {
	return Array.from(
		new Set(values.map((value) => value.trim()).filter(Boolean)),
	);
}

async function updatePullRequestMembers({
	workspaceId,
	kind,
	add,
	remove,
	pullRequestNumber,
	pullRequestUrl,
}: {
	workspaceId: string;
	kind: "reviewer" | "assignee";
	add: string[];
	remove: string[];
	pullRequestNumber?: number;
	pullRequestUrl?: string;
}): Promise<{ success: true }> {
	const normalizedAdd = normalizeIdentityList(add);
	const normalizedRemove = normalizeIdentityList(remove);

	if (normalizedAdd.length === 0 && normalizedRemove.length === 0) {
		return { success: true };
	}

	const {
		repoPath,
		worktree,
		repoNameWithOwner,
		pullRequestNumber: resolvedPr,
	} = resolvePullRequestTarget({
		workspaceId,
		pullRequestNumber,
		pullRequestUrl,
	});

	const args = ["pr", "edit", String(resolvedPr), "--repo", repoNameWithOwner];

	if (normalizedAdd.length > 0) {
		args.push(
			kind === "reviewer" ? "--add-reviewer" : "--add-assignee",
			normalizedAdd.join(","),
		);
	}

	if (normalizedRemove.length > 0) {
		args.push(
			kind === "reviewer" ? "--remove-reviewer" : "--remove-assignee",
			normalizedRemove.join(","),
		);
	}

	await execWithShellEnv("gh", args, { cwd: repoPath });
	clearGitHubCachesForWorktree(repoPath);

	if (worktree) {
		localDb
			.update(worktrees)
			.set({ githubStatus: null })
			.where(eq(worktrees.id, worktree.id))
			.run();
	}

	return { success: true };
}

async function getPullRequestIdentityCandidates({
	workspaceId,
	kind,
	pullRequestUrl,
}: {
	workspaceId: string;
	kind: "reviewer" | "assignee";
	pullRequestUrl?: string;
}): Promise<Array<{ login: string; avatarUrl: string | null }>> {
	const { repoPath, repoNameWithOwner } = resolvePullRequestRepoTarget({
		workspaceId,
		pullRequestUrl,
	});

	const [owner, name] = repoNameWithOwner.split("/");
	if (!owner || !name) {
		return [];
	}

	const fieldName =
		kind === "assignee" ? "assignableUsers" : "mentionableUsers";
	const query = `query PullRequestIdentityCandidates($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    users: ${fieldName}(first: 100, after: $after) {
      nodes {
        login
        avatarUrl
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

	const usersByLogin = new Map<string, string | null>();
	let afterCursor: string | null = null;

	while (true) {
		const args = [
			"api",
			"graphql",
			"-f",
			`query=${query}`,
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
		];
		if (afterCursor) {
			args.push("-F", `after=${afterCursor}`);
		}

		const { stdout } = await execWithShellEnv("gh", args, { cwd: repoPath });
		const raw = JSON.parse(stdout) as unknown;
		const parsed = GHIdentityCandidatesResponseSchema.safeParse(raw);
		if (!parsed.success) {
			console.warn(
				"[GitHub] Failed to parse pull request identity candidates:",
				parsed.error.message,
			);
			break;
		}

		const users = parsed.data.data.repository?.users;
		if (!users) {
			break;
		}

		for (const user of users.nodes ?? []) {
			if (user?.login) {
				usersByLogin.set(user.login, user.avatarUrl ?? null);
			}
		}

		if (!users.pageInfo.hasNextPage || !users.pageInfo.endCursor) {
			break;
		}

		afterCursor = users.pageInfo.endCursor;
	}

	return [...usersByLogin.entries()].map(([login, avatarUrl]) => ({
		login,
		avatarUrl,
	}));
}

export const createGitStatusProcedures = () => {
	return router({
		refreshGitStatus: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					throw new Error(`Workspace ${input.workspaceId} not found`);
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;
				if (!worktree) {
					throw new Error(
						`Worktree for workspace ${input.workspaceId} not found`,
					);
				}

				const project = getProject(workspace.projectId);
				if (!project) {
					throw new Error(`Project ${workspace.projectId} not found`);
				}

				const remoteDefaultBranch = await refreshDefaultBranch(
					project.mainRepoPath,
				);

				let defaultBranch = project.defaultBranch;
				if (!defaultBranch) {
					defaultBranch = await getDefaultBranch(project.mainRepoPath);
				}
				if (remoteDefaultBranch && remoteDefaultBranch !== defaultBranch) {
					defaultBranch = remoteDefaultBranch;
				}

				if (defaultBranch !== project.defaultBranch) {
					updateProjectDefaultBranch(project.id, defaultBranch);
				}

				await fetchDefaultBranch(project.mainRepoPath, defaultBranch);

				const { ahead, behind } = await getAheadBehindCount({
					repoPath: worktree.path,
					defaultBranch,
				});

				const gitStatus = {
					branch: worktree.branch,
					needsRebase: behind > 0,
					ahead,
					behind,
					lastRefreshed: Date.now(),
				};

				localDb
					.update(worktrees)
					.set({ gitStatus })
					.where(eq(worktrees.id, worktree.id))
					.run();

				return { gitStatus, defaultBranch };
			}),

		getAheadBehind: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return { ahead: 0, behind: 0 };
				}

				const project = getProject(workspace.projectId);
				if (!project) {
					return { ahead: 0, behind: 0 };
				}

				return getAheadBehindCount({
					repoPath: project.mainRepoPath,
					defaultBranch: workspace.branch,
				});
			}),

		getGitHubStatus: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					forceFresh: z.boolean().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return null;
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;

				// For "branch" type workspaces without a worktree record,
				// fall back to the project's mainRepoPath
				let repoPath: string | null = worktree?.path ?? null;
				if (!repoPath && workspace.type === "branch") {
					const project = getProject(workspace.projectId);
					repoPath = project?.mainRepoPath ?? null;
				}
				if (!repoPath) {
					return null;
				}

				if (input.forceFresh) {
					clearGitHubCachesForWorktree(repoPath);
				}

				const freshStatus = await fetchGitHubPRStatus(repoPath);

				if (
					worktree &&
					hasMeaningfulGitHubStatusChange({
						current: worktree.githubStatus,
						next: freshStatus,
					})
				) {
					localDb
						.update(worktrees)
						.set({ githubStatus: freshStatus })
						.where(eq(worktrees.id, worktree.id))
						.run();
				}

				return freshStatus;
			}),

		getGitHubPRComments: publicProcedure
			.input(gitHubPRCommentsInputSchema)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return [];
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;

				let repoPath: string | null = worktree?.path ?? null;
				if (!repoPath && workspace.type === "branch") {
					const project = getProject(workspace.projectId);
					repoPath = project?.mainRepoPath ?? null;
				}
				if (!repoPath) {
					return [];
				}

				if (input.forceFresh) {
					clearGitHubCachesForWorktree(repoPath);
				}

				const cachedGitHubStatus = worktree?.githubStatus ?? null;

				return fetchGitHubPRComments({
					worktreePath: repoPath,
					pullRequest: resolveCommentsPullRequestTarget({
						input,
						githubStatus: cachedGitHubStatus,
					}),
				});
			}),

		getPullRequestIdentityCandidates: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					kind: z.enum(["reviewer", "assignee"]),
					pullRequestUrl: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				return getPullRequestIdentityCandidates(input);
			}),

		getGitHubRepositoryOverview: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
				}),
			)
			.query(async ({ input }) => {
				return getGitHubRepositoryOverview(input.workspaceId);
			}),

		createGitHubIssue: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					title: z.string().trim().min(1),
					body: z.string().optional(),
					assignees: z.array(z.string()).optional(),
					labels: z.array(z.string()).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return createGitHubIssueForWorkspace(input);
			}),

		uploadGitHubIssueAsset: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					filename: z.string().trim().min(1),
					contentBase64: z.string().trim().min(1),
					mimeType: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return uploadIssueAssetForWorkspace(input);
			}),

		dispatchGitHubWorkflow: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					workflowId: z.number().int().positive(),
					ref: z.string().optional(),
					inputs: z.record(z.string(), z.string()).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return dispatchGitHubWorkflowForWorkspace(input);
			}),

		getGitHubWorkflowRuns: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					workflowId: z.number().int().positive(),
				}),
			)
			.query(async ({ input }) => {
				return getGitHubWorkflowRunsForWorkspace(input);
			}),

		getWorkflowRunJobs: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					runId: z.number().int().positive(),
				}),
			)
			.query(async ({ input }) => {
				return getWorkflowRunJobsForWorkspace(input);
			}),

		rerunPullRequestChecks: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					mode: z.enum(["all", "failed"]),
				}),
			)
			.mutation(async ({ input }) => {
				return rerunPullRequestChecksForWorkspace(input);
			}),

		setPullRequestDraftState: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					isDraft: z.boolean(),
				}),
			)
			.mutation(async ({ input }) => {
				const { repoPath, worktree, pullRequest } =
					await getFreshPullRequestForWorkspace(input.workspaceId);

				const isCurrentlyDraft = pullRequest.state === "draft";
				if (pullRequest.state !== "draft" && pullRequest.state !== "open") {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"Only open or draft pull requests can be updated from Review.",
					});
				}

				if (input.isDraft === isCurrentlyDraft) {
					return { success: true };
				}

				const repoNameWithOwner = extractNwoFromUrl(pullRequest.url);
				if (!repoNameWithOwner) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Could not determine the pull request repository.",
					});
				}

				const args = [
					"pr",
					"ready",
					String(pullRequest.number),
					"--repo",
					repoNameWithOwner,
				];
				if (input.isDraft) {
					args.push("--undo");
				}

				await execWithShellEnv("gh", args, { cwd: repoPath });
				clearGitHubCachesForWorktree(repoPath);

				if (worktree) {
					localDb
						.update(worktrees)
						.set({ githubStatus: null })
						.where(eq(worktrees.id, worktree.id))
						.run();
				}

				return { success: true };
			}),

		setPullRequestThreadResolution: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					threadId: z.string().min(1),
					isResolved: z.boolean(),
				}),
			)
			.mutation(async ({ input }) => {
				const { repoPath, worktree } = resolveRepoPathForWorkspace(
					input.workspaceId,
				);
				const mutationName = input.isResolved
					? "resolveReviewThread"
					: "unresolveReviewThread";
				const mutationQuery = `mutation ${mutationName}($threadId: ID!) {
  ${mutationName}(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

				await execWithShellEnv(
					"gh",
					[
						"api",
						"graphql",
						"-f",
						`query=${mutationQuery}`,
						"-F",
						`threadId=${input.threadId}`,
					],
					{ cwd: repoPath },
				);

				clearGitHubCachesForWorktree(repoPath);
				if (worktree) {
					localDb
						.update(worktrees)
						.set({ githubStatus: null })
						.where(eq(worktrees.id, worktree.id))
						.run();
				}

				return { success: true };
			}),

		updatePullRequestReviewers: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					add: z.array(z.string()).optional().default([]),
					remove: z.array(z.string()).optional().default([]),
					pullRequestNumber: z.number().int().positive().optional(),
					pullRequestUrl: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return updatePullRequestMembers({
					workspaceId: input.workspaceId,
					kind: "reviewer",
					add: input.add,
					remove: input.remove,
					pullRequestNumber: input.pullRequestNumber,
					pullRequestUrl: input.pullRequestUrl,
				});
			}),

		updatePullRequestAssignees: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					add: z.array(z.string()).optional().default([]),
					remove: z.array(z.string()).optional().default([]),
					pullRequestNumber: z.number().int().positive().optional(),
					pullRequestUrl: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return updatePullRequestMembers({
					workspaceId: input.workspaceId,
					kind: "assignee",
					add: input.add,
					remove: input.remove,
					pullRequestNumber: input.pullRequestNumber,
					pullRequestUrl: input.pullRequestUrl,
				});
			}),

		getWorktreeInfo: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return null;
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;
				if (!worktree) {
					return null;
				}

				const worktreeName = worktree.path.split("/").pop() ?? worktree.branch;
				const branchName = worktree.branch;

				return {
					worktreeName,
					branchName,
					createdAt: worktree.createdAt,
					gitStatus: worktree.gitStatus ?? null,
					githubStatus: worktree.githubStatus ?? null,
				};
			}),

		getWorktreesByProject: publicProcedure
			.input(z.object({ projectId: z.string() }))
			.query(({ input }) => {
				const projectWorktrees = localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.projectId, input.projectId))
					.all();

				return projectWorktrees.map((wt) => {
					const workspace = localDb
						.select()
						.from(workspaces)
						.where(
							and(
								eq(workspaces.worktreeId, wt.id),
								isNull(workspaces.deletingAt),
							),
						)
						.get();
					return {
						...wt,
						hasActiveWorkspace: workspace !== undefined,
						existsOnDisk: existsSync(wt.path),
						workspace: workspace ?? null,
					};
				});
			}),

		getExternalWorktrees: publicProcedure
			.input(z.object({ projectId: z.string() }))
			.query(async ({ input }) => {
				const project = getProject(input.projectId);
				if (!project) {
					return [];
				}

				const allWorktrees = await listExternalWorktrees(project.mainRepoPath);

				const trackedWorktrees = localDb
					.select({ path: worktrees.path })
					.from(worktrees)
					.where(eq(worktrees.projectId, input.projectId))
					.all();
				const trackedPaths = new Set(trackedWorktrees.map((wt) => wt.path));

				return allWorktrees
					.filter((wt) => {
						if (wt.path === project.mainRepoPath) return false;
						if (wt.isBare) return false;
						if (wt.isDetached) return false;
						if (!wt.branch) return false;
						if (trackedPaths.has(wt.path)) return false;
						return true;
					})
					.map((wt) => ({
						path: wt.path,
						// biome-ignore lint/style/noNonNullAssertion: filtered above
						branch: wt.branch!,
					}));
			}),

		getCheckJobSteps: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					detailsUrl: z.string(),
				}),
			)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return [];
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;

				let repoPath: string | null = worktree?.path ?? null;
				if (!repoPath && workspace.type === "branch") {
					const project = getProject(workspace.projectId);
					repoPath = project?.mainRepoPath ?? null;
				}
				if (!repoPath) {
					return [];
				}

				return fetchCheckJobSteps(repoPath, input.detailsUrl);
			}),

		getJobLogs: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					detailsUrl: z.string(),
				}),
			)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return {
						jobStatus: "queued" as const,
						jobConclusion: null,
						steps: [],
					};
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;

				let repoPath: string | null = worktree?.path ?? null;
				if (!repoPath && workspace.type === "branch") {
					const project = getProject(workspace.projectId);
					repoPath = project?.mainRepoPath ?? null;
				}
				if (!repoPath) {
					return {
						jobStatus: "queued" as const,
						jobConclusion: null,
						steps: [],
					};
				}

				return fetchStructuredJobLogs(repoPath, input.detailsUrl);
			}),

		getJobStatuses: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					detailsUrls: z.array(z.string()),
				}),
			)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					return [];
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;

				let repoPath: string | null = worktree?.path ?? null;
				if (!repoPath && workspace.type === "branch") {
					const project = getProject(workspace.projectId);
					repoPath = project?.mainRepoPath ?? null;
				}
				if (!repoPath) {
					return [];
				}

				return fetchJobStatuses(repoPath, input.detailsUrls);
			}),
	});
};
