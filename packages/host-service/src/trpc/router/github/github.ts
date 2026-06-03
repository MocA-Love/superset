import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import yaml from "js-yaml";
import { z } from "zod";
import { projects, workspaces } from "../../../db/schema";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";
import { getDefaultBranchName } from "../git/utils/git-helpers";
import { resolveGithubRepo } from "../workspace-creation/shared/project-helpers";

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

const GITHUB_REPOSITORY_QUERY_CACHE_TTL_MS = 30_000;

const githubRepositoryQueryCache = new Map<
	string,
	{ expiresAt: number; promise: Promise<unknown> }
>();

function readCachedGitHubRepositoryQuery<T>(
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const cached = githubRepositoryQueryCache.get(key);
	if (cached && cached.expiresAt > now) {
		return cached.promise as Promise<T>;
	}

	const promise = load();
	promise.catch(() => {});
	githubRepositoryQueryCache.set(key, {
		expiresAt: now + GITHUB_REPOSITORY_QUERY_CACHE_TTL_MS,
		promise: promise as Promise<unknown>,
	});
	return promise;
}

function invalidateGitHubRepositoryQueryCache(prefix: string): void {
	for (const key of githubRepositoryQueryCache.keys()) {
		if (key.startsWith(prefix)) {
			githubRepositoryQueryCache.delete(key);
		}
	}
}

function normalizeIdentityList(values: string[]): string[] {
	return Array.from(
		new Set(values.map((value) => value.trim()).filter(Boolean)),
	);
}

async function loadRepositorySegment<T>({
	label,
	load,
	fallback,
	workspaceId,
	repositoryNameWithOwner,
}: {
	label: string;
	load: () => Promise<T>;
	fallback: T;
	workspaceId: string;
	repositoryNameWithOwner: string;
}): Promise<T> {
	try {
		return await load();
	} catch (error) {
		console.warn("[github/repository-overview] Falling back to empty segment", {
			label,
			workspaceId,
			repositoryNameWithOwner,
			error,
		});
		return fallback;
	}
}

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

	try {
		const parsed = yaml.load(content) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") {
			return noDispatch;
		}

		const onBlock = parsed.on ?? parsed.true;
		if (onBlock === "workflow_dispatch") {
			return { supportsDispatch: true, inputs: [] };
		}

		if (Array.isArray(onBlock)) {
			return onBlock.map(String).includes("workflow_dispatch")
				? { supportsDispatch: true, inputs: [] }
				: noDispatch;
		}

		if (!onBlock || typeof onBlock !== "object") {
			return noDispatch;
		}

		if (!Object.hasOwn(onBlock, "workflow_dispatch")) {
			return noDispatch;
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
		return noDispatch;
	}
}

async function resolveRepositoryTarget(
	ctx: HostServiceContext,
	workspaceId: string,
) {
	const workspace = ctx.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();
	if (!workspace) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workspace not found",
		});
	}

	const project = ctx.db.query.projects
		.findFirst({ where: eq(projects.id, workspace.projectId) })
		.sync();
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}

	const repo = await resolveGithubRepo(ctx, workspace.projectId);
	const repoPath = workspace.worktreePath || repo.repoPath;
	const git = await ctx.git(repoPath);
	const branchSummary = await git.branch();
	const currentBranch = branchSummary.current || workspace.branch;
	const defaultBranch = (await getDefaultBranchName(git)) ?? "main";
	const repositoryNameWithOwner = `${repo.owner}/${repo.name}`;
	const repositoryUrl = `https://github.com/${repositoryNameWithOwner}`;
	const upstreamOwner =
		workspace.upstreamOwner ?? project.repoOwner ?? repo.owner;
	const upstreamRepo = workspace.upstreamRepo ?? project.repoName ?? repo.name;
	const upstreamNameWithOwner = `${upstreamOwner}/${upstreamRepo}`;
	const upstreamUrl = `https://github.com/${upstreamNameWithOwner}`;
	let branchExistsOnRemote = false;
	try {
		await git.raw([
			"ls-remote",
			"--exit-code",
			"--heads",
			"origin",
			currentBranch,
		]);
		branchExistsOnRemote = true;
	} catch {
		branchExistsOnRemote = false;
	}

	return {
		workspace,
		repoPath,
		repositoryNameWithOwner,
		repositoryUrl,
		upstreamNameWithOwner,
		upstreamUrl,
		isFork: upstreamNameWithOwner !== repositoryNameWithOwner,
		branchExistsOnRemote,
		currentBranch,
		defaultBranch,
	};
}

async function ensureGitHubBranchExists({
	ctx,
	repoPath,
	repositoryNameWithOwner,
	branchName,
	baseBranch,
}: {
	ctx: HostServiceContext;
	repoPath: string;
	repositoryNameWithOwner: string;
	branchName: string;
	baseBranch: string;
}) {
	try {
		await ctx.execGh(
			["api", `repos/${repositoryNameWithOwner}/git/ref/heads/${branchName}`],
			{ cwd: repoPath, timeout: 30_000 },
		);
		return;
	} catch (error) {
		const errorText =
			error instanceof Error ? error.message.toLowerCase() : String(error);
		const isMissingRefError =
			errorText.includes("404") ||
			errorText.includes("not found") ||
			errorText.includes("no ref found");
		if (!isMissingRefError) {
			throw error;
		}
	}

	const raw = (await ctx.execGh(
		["api", `repos/${repositoryNameWithOwner}/git/ref/heads/${baseBranch}`],
		{ cwd: repoPath, timeout: 30_000 },
	)) as { object?: { sha?: string } };
	const sha = raw.object?.sha;
	if (!sha) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Could not determine the base branch SHA for issue assets.",
		});
	}

	await ctx.execGh(
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
		{ cwd: repoPath, timeout: 30_000 },
	);
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

export const githubRouter = router({
	getPRStatus: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				branch: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.pulls.list({
				owner: input.owner,
				repo: input.repo,
				head: `${input.owner}:${input.branch}`,
				state: "open",
			});
			return data[0] ?? null;
		}),

	getPR: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				pullNumber: z.number(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.pulls.get({
				owner: input.owner,
				repo: input.repo,
				pull_number: input.pullNumber,
			});
			return data;
		}),

	listPRs: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				state: z.enum(["open", "closed", "all"]).default("open"),
				sort: z
					.enum(["created", "updated", "popularity", "long-running"])
					.default("updated"),
				direction: z.enum(["asc", "desc"]).default("desc"),
				perPage: z.number().min(1).max(100).default(30),
				page: z.number().min(1).default(1),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.pulls.list({
				owner: input.owner,
				repo: input.repo,
				state: input.state,
				sort: input.sort,
				direction: input.direction,
				per_page: input.perPage,
				page: input.page,
			});
			return data;
		}),

	getRepo: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.repos.get({
				owner: input.owner,
				repo: input.repo,
			});
			return data;
		}),

	listDeployments: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				environment: z.string().optional(),
				ref: z.string().optional(),
				perPage: z.number().min(1).max(100).default(10),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.repos.listDeployments({
				owner: input.owner,
				repo: input.repo,
				environment: input.environment,
				ref: input.ref,
				per_page: input.perPage,
			});
			return data;
		}),

	listDeploymentStatuses: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				deploymentId: z.number(),
				perPage: z.number().min(1).max(100).default(10),
			}),
		)
		.query(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.repos.listDeploymentStatuses({
				owner: input.owner,
				repo: input.repo,
				deployment_id: input.deploymentId,
				per_page: input.perPage,
			});
			return data;
		}),

	getUser: protectedProcedure.query(async ({ ctx }) => {
		const octokit = await ctx.github();
		const { data } = await octokit.users.getAuthenticated();
		return data;
	}),

	getRepositoryOverview: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input }) => {
			return readCachedGitHubRepositoryQuery(
				`repository-overview:${input.workspaceId}`,
				async () => {
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
					} = await resolveRepositoryTarget(ctx, input.workspaceId);

					const [pullRequests, workflows, labels, assignees] =
						await Promise.all([
							loadRepositorySegment({
								label: "pullRequests",
								workspaceId: input.workspaceId,
								repositoryNameWithOwner,
								fallback: [] as Array<
									z.infer<typeof ghRepositoryPullRequestSchema>
								>,
								load: async () => {
									const result = await ctx.execGh(
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
										{ cwd: repoPath, timeout: 30_000 },
									);
									return z.array(ghRepositoryPullRequestSchema).parse(result);
								},
							}),
							loadRepositorySegment({
								label: "workflows",
								workspaceId: input.workspaceId,
								repositoryNameWithOwner,
								fallback: [] as Array<
									z.infer<typeof ghRepositoryWorkflowSchema>
								>,
								load: async () => {
									const result = await ctx.execGh(
										[
											"api",
											`repos/${repositoryNameWithOwner}/actions/workflows?per_page=100`,
										],
										{ cwd: repoPath, timeout: 30_000 },
									);
									return (
										ghRepositoryWorkflowsResponseSchema.parse(result)
											.workflows ?? []
									);
								},
							}),
							loadRepositorySegment({
								label: "labels",
								workspaceId: input.workspaceId,
								repositoryNameWithOwner,
								fallback: [] as Array<z.infer<typeof ghRepositoryLabelSchema>>,
								load: async () => {
									const result = await ctx.execGh(
										[
											"api",
											`repos/${repositoryNameWithOwner}/labels?per_page=100`,
										],
										{ cwd: repoPath, timeout: 30_000 },
									);
									return z.array(ghRepositoryLabelSchema).parse(result);
								},
							}),
							loadRepositorySegment({
								label: "assignees",
								workspaceId: input.workspaceId,
								repositoryNameWithOwner,
								fallback: [] as Array<
									z.infer<typeof ghRepositoryAssigneeSchema>
								>,
								load: async () => {
									const result = await ctx.execGh(
										[
											"api",
											`repos/${repositoryNameWithOwner}/assignees?per_page=100`,
										],
										{ cwd: repoPath, timeout: 30_000 },
									);
									return z.array(ghRepositoryAssigneeSchema).parse(result);
								},
							}),
						]);

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
							state: pullRequest.isDraft
								? "draft"
								: pullRequest.state.toLowerCase(),
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
				},
			);
		}),

	createIssue: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				title: z.string().trim().min(1),
				body: z.string().optional(),
				assignees: z.array(z.string()).optional(),
				labels: z.array(z.string()).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { repoPath, repositoryNameWithOwner } =
				await resolveRepositoryTarget(ctx, input.workspaceId);
			const args = [
				"issue",
				"create",
				"--repo",
				repositoryNameWithOwner,
				"--title",
				input.title.trim(),
				"--body",
				input.body?.trim() || "",
			];
			const assignees = normalizeIdentityList(input.assignees ?? []);
			const labels = normalizeIdentityList(input.labels ?? []);
			if (assignees.length > 0) {
				args.push("--assignee", assignees.join(","));
			}
			if (labels.length > 0) {
				args.push("--label", labels.join(","));
			}

			const result = await ctx.execGh(args, { cwd: repoPath, timeout: 30_000 });
			return {
				url: typeof result === "string" ? result.trim() : "",
			};
		}),

	uploadIssueAsset: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				filename: z.string().trim().min(1),
				contentBase64: z.string().trim().min(1),
				mimeType: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { repoPath, repositoryNameWithOwner, defaultBranch } =
				await resolveRepositoryTarget(ctx, input.workspaceId);
			const assetBranch = "superset-issue-assets";
			await ensureGitHubBranchExists({
				ctx,
				repoPath,
				repositoryNameWithOwner,
				branchName: assetBranch,
				baseBranch: defaultBranch,
			});

			const now = new Date();
			const extension = getIssueAssetExtension({
				filename: input.filename,
				mimeType: input.mimeType,
			});
			const basename =
				sanitizeIssueAssetBasename(input.filename.replace(/\.[^.]+$/, "")) ||
				"pasted-image";
			const timestamp = now.toISOString().replace(/[:.]/g, "-");
			const assetPath = [
				".superset",
				"issue-assets",
				String(now.getUTCFullYear()),
				String(now.getUTCMonth() + 1).padStart(2, "0"),
				`${timestamp}-${basename}.${extension}`,
			].join("/");

			await ctx.execGh(
				[
					"api",
					"--method",
					"PUT",
					`repos/${repositoryNameWithOwner}/contents/${assetPath}`,
					"-f",
					`message=Add issue asset ${assetPath}`,
					"-f",
					`content=${input.contentBase64}`,
					"-f",
					`branch=${assetBranch}`,
				],
				{ cwd: repoPath, timeout: 60_000 },
			);

			const assetUrl = `https://github.com/${repositoryNameWithOwner}/raw/${assetBranch}/${assetPath}`;
			return {
				name: `${basename}.${extension}`,
				url: assetUrl,
				markdown: `![${basename}](${assetUrl})`,
			};
		}),

	dispatchWorkflow: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				workflowId: z.number().int().positive(),
				ref: z.string().optional(),
				inputs: z.record(z.string(), z.string()).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const {
				repoPath,
				repositoryNameWithOwner,
				currentBranch,
				defaultBranch,
				branchExistsOnRemote,
			} = await resolveRepositoryTarget(ctx, input.workspaceId);
			const requestedRef = input.ref?.trim() || currentBranch || defaultBranch;
			const targetRef =
				requestedRef === currentBranch && !branchExistsOnRemote
					? defaultBranch
					: requestedRef;
			const args = [
				"api",
				"--method",
				"POST",
				`repos/${repositoryNameWithOwner}/actions/workflows/${input.workflowId}/dispatches`,
				"-f",
				`ref=${targetRef}`,
			];

			if (input.inputs) {
				for (const [key, value] of Object.entries(input.inputs)) {
					args.push("-f", `inputs[${key}]=${value}`);
				}
			}

			await ctx.execGh(args, { cwd: repoPath, timeout: 30_000 });
			invalidateGitHubRepositoryQueryCache(
				`workflow-runs:${input.workspaceId}:${input.workflowId}`,
			);
			invalidateGitHubRepositoryQueryCache(
				`repository-overview:${input.workspaceId}`,
			);
			return {
				success: true as const,
				ref: targetRef,
				dispatchedAt: new Date().toISOString(),
			};
		}),

	getWorkflowRuns: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				workflowId: z.number().int().positive(),
			}),
		)
		.query(async ({ ctx, input }) => {
			return readCachedGitHubRepositoryQuery(
				`workflow-runs:${input.workspaceId}:${input.workflowId}`,
				async () => {
					const { repoPath, repositoryNameWithOwner } =
						await resolveRepositoryTarget(ctx, input.workspaceId);
					const result = await ctx.execGh(
						[
							"api",
							`repos/${repositoryNameWithOwner}/actions/workflows/${input.workflowId}/runs?per_page=10&event=workflow_dispatch`,
						],
						{ cwd: repoPath, timeout: 30_000 },
					);
					const runs =
						ghRepositoryWorkflowRunsResponseSchema.parse(result)
							.workflow_runs ?? [];
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
						workflowId: run.workflow_id ?? input.workflowId,
					}));
				},
			);
		}),

	getWorkflowRunJobs: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				runId: z.number().int().positive(),
			}),
		)
		.query(async ({ ctx, input }) => {
			return readCachedGitHubRepositoryQuery(
				`workflow-run-jobs:${input.workspaceId}:${input.runId}`,
				async () => {
					const { repoPath, repositoryNameWithOwner } =
						await resolveRepositoryTarget(ctx, input.workspaceId);
					const result = await ctx.execGh(
						[
							"api",
							`repos/${repositoryNameWithOwner}/actions/runs/${input.runId}/jobs?per_page=100`,
						],
						{ cwd: repoPath, timeout: 30_000 },
					);
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
						.parse(result);

					return (parsed.jobs ?? []).map((job) => ({
						detailsUrl: job.html_url ?? "",
						name: job.name,
						status: mapJobStatus(job.status, job.conclusion),
					}));
				},
			);
		}),

	mergePR: protectedProcedure
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				pullNumber: z.number(),
				mergeMethod: z.enum(["merge", "squash", "rebase"]).default("merge"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const octokit = await ctx.github();
			const { data } = await octokit.pulls.merge({
				owner: input.owner,
				repo: input.repo,
				pull_number: input.pullNumber,
				merge_method: input.mergeMethod,
			});
			return data;
		}),
});
