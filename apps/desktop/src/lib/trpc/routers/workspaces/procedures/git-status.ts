import { existsSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import type { GitHubStatus } from "@superset/local-db";
import { workspaces, worktrees } from "@superset/local-db";
import { and, eq, isNull } from "drizzle-orm";
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
	fetchDefaultBranch,
	getAheadBehindCount,
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
	type PullRequestCommentsTarget,
} from "../utils/github";
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
	next: GitHubStatus;
}): boolean {
	return (
		JSON.stringify(stripGitHubStatusTimestamp(current)) !==
		JSON.stringify(stripGitHubStatusTimestamp(next))
	);
}

function resolveRepoPathForWorkspace(workspaceId: string): {
	workspace: ReturnType<typeof getWorkspace>;
	worktree: ReturnType<typeof getWorktree>;
	repoPath: string;
} {
	const workspace = getWorkspace(workspaceId);
	if (!workspace) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Workspace ${workspaceId} not found`,
		});
	}

	const worktree = workspace.worktreeId ? getWorktree(workspace.worktreeId) : null;
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
	worktree: ReturnType<typeof getWorktree>;
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
					freshStatus &&
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
	});
};
