import { worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import type { SimpleGit } from "simple-git";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	getBranchBaseConfig,
	setBranchBaseConfig,
	unsetBranchBaseConfig,
} from "../workspaces/utils/base-branch-config";
import { getCurrentBranch } from "../workspaces/utils/git";
import { getSimpleGitWithShellPath } from "../workspaces/utils/git-client";
import { gitCreateBranch, gitSwitchBranch } from "./security/git-commands";
import { assertRegisteredWorktree } from "./security/path-validation";
import { clearStatusCacheForWorktree } from "./utils/status-cache";

const DEFAULT_REF_SEARCH_LIMIT = 50;
const MAX_REF_SEARCH_LIMIT = 200;

type SearchableRef = {
	name: string;
	ref: string;
	kind: "branch" | "tag";
	lastCommitDate: number;
	isLocal: boolean;
	isRemote: boolean;
	checkedOutPath: string | null;
};

export const createBranchesRouter = () => {
	return router({
		getBranches: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.query(
				async ({
					input,
				}): Promise<{
					local: Array<{ branch: string; lastCommitDate: number }>;
					remote: string[];
					defaultBranch: string;
					checkedOutBranches: Record<string, string>;
					worktreeBaseBranch: string | null;
					currentBranch: string | null;
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getSimpleGitWithShellPath(input.worktreePath);

					const branchSummary = await git.branch(["-a"]);
					const currentBranch = await getCurrentBranch(input.worktreePath);
					const { compareBaseBranch: configuredCompareBaseBranch } =
						currentBranch
							? await getBranchBaseConfig({
									repoPath: input.worktreePath,
									branch: currentBranch,
								})
							: { compareBaseBranch: null };
					const persistedWorktree = localDb
						.select({
							branch: worktrees.branch,
							baseBranch: worktrees.baseBranch,
						})
						.from(worktrees)
						.where(eq(worktrees.path, input.worktreePath))
						.get();
					const persistedBaseBranch =
						persistedWorktree &&
						(!currentBranch || persistedWorktree.branch === currentBranch)
							? (persistedWorktree.baseBranch?.trim() ?? null)
							: null;

					const localBranches: string[] = [];
					const remote: string[] = [];

					for (const name of Object.keys(branchSummary.branches)) {
						if (name.startsWith("remotes/origin/")) {
							if (name === "remotes/origin/HEAD") continue;
							const remoteName = name.replace("remotes/origin/", "");
							remote.push(remoteName);
						} else {
							localBranches.push(name);
						}
					}

					const local = await getLocalBranchesWithDates(git, localBranches);
					const defaultBranch = await getDefaultBranch(git, remote);
					const checkedOutBranches = await getCheckedOutBranches(
						git,
						input.worktreePath,
					);

					return {
						local,
						remote: remote.sort(),
						defaultBranch,
						checkedOutBranches,
						worktreeBaseBranch:
							configuredCompareBaseBranch ?? persistedBaseBranch,
						currentBranch,
					};
				},
			),

		searchRefs: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					search: z.string().default(""),
					limit: z.number().int().min(1).max(MAX_REF_SEARCH_LIMIT).optional(),
					includeTags: z.boolean().default(true),
				}),
			)
			.query(
				async ({
					input,
				}): Promise<{
					refs: SearchableRef[];
					defaultBranch: string;
					currentBranch: string | null;
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getSimpleGitWithShellPath(input.worktreePath);
					const currentBranch = await getCurrentBranch(input.worktreePath);
					const checkedOutBranches = await getCheckedOutBranches(
						git,
						input.worktreePath,
					);
					const refs = await getSearchableRefs(git, {
						search: input.search,
						includeTags: input.includeTags,
					});
					const remoteBranchNames = refs
						.filter((ref) => ref.kind === "branch" && ref.isRemote)
						.map((ref) => ref.name);
					const defaultBranch = await getDefaultBranch(git, remoteBranchNames);

					const sortedRefs = refs.sort((a, b) => {
						if (a.kind !== b.kind) return a.kind === "branch" ? -1 : 1;
						if (a.kind === "branch" && b.kind === "branch") {
							if (a.name === currentBranch) return -1;
							if (b.name === currentBranch) return 1;
							if (a.name === defaultBranch) return -1;
							if (b.name === defaultBranch) return 1;
							if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
						}
						if (a.lastCommitDate !== b.lastCommitDate) {
							return b.lastCommitDate - a.lastCommitDate;
						}
						return a.name.localeCompare(b.name);
					});

					return {
						refs: sortedRefs
							.slice(0, input.limit ?? DEFAULT_REF_SEARCH_LIMIT)
							.map((ref) => ({
								...ref,
								checkedOutPath:
									ref.kind === "branch"
										? (checkedOutBranches[ref.name] ?? null)
										: null,
							})),
						defaultBranch,
						currentBranch,
					};
				},
			),

		switchBranch: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					branch: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				await gitSwitchBranch(input.worktreePath, input.branch);
				const currentBranch =
					(await getCurrentBranch(input.worktreePath)) ?? input.branch;
				persistWorktreeBranch(input.worktreePath, currentBranch);

				clearStatusCacheForWorktree(input.worktreePath);
				return { success: true };
			}),

		createBranch: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					branch: z.string(),
					startPoint: z.string().nullish(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; branch: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getSimpleGitWithShellPath(input.worktreePath);
					const branchSummary = await git.branchLocal();
					if (branchSummary.all.includes(input.branch)) {
						throw new Error(`Branch "${input.branch}" already exists.`);
					}

					await gitCreateBranch(
						input.worktreePath,
						input.branch,
						input.startPoint ?? undefined,
					);
					const currentBranch =
						(await getCurrentBranch(input.worktreePath)) ?? input.branch;
					persistWorktreeBranch(input.worktreePath, currentBranch);

					clearStatusCacheForWorktree(input.worktreePath);
					return { success: true, branch: currentBranch };
				},
			),

		updateBaseBranch: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					baseBranch: z.string().nullable(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const currentBranch = await getCurrentBranch(input.worktreePath);
				if (!currentBranch) {
					throw new Error("Could not determine current branch");
				}

				if (input.baseBranch) {
					await setBranchBaseConfig({
						repoPath: input.worktreePath,
						branch: currentBranch,
						compareBaseBranch: input.baseBranch,
						isExplicit: true,
					});
				} else {
					await unsetBranchBaseConfig({
						repoPath: input.worktreePath,
						branch: currentBranch,
					});
				}

				const persistedWorktree = getPersistedWorktree(input.worktreePath);
				if (persistedWorktree) {
					localDb
						.update(worktrees)
						.set({ baseBranch: input.baseBranch })
						.where(eq(worktrees.path, input.worktreePath))
						.run();
				}

				clearStatusCacheForWorktree(input.worktreePath);
				return { success: true };
			}),
	});
};

async function getLocalBranchesWithDates(
	git: SimpleGit,
	localBranches: string[],
): Promise<Array<{ branch: string; lastCommitDate: number }>> {
	try {
		const branchInfo = await git.raw([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short) %(committerdate:unix)",
			"refs/heads/",
		]);

		const local: Array<{ branch: string; lastCommitDate: number }> = [];
		for (const line of branchInfo.trim().split("\n")) {
			if (!line) continue;
			const lastSpaceIdx = line.lastIndexOf(" ");
			const branch = line.substring(0, lastSpaceIdx);
			const timestamp = Number.parseInt(line.substring(lastSpaceIdx + 1), 10);
			if (localBranches.includes(branch)) {
				local.push({
					branch,
					lastCommitDate: timestamp * 1000,
				});
			}
		}
		return local;
	} catch {
		return localBranches.map((branch) => ({ branch, lastCommitDate: 0 }));
	}
}

async function getDefaultBranch(
	git: SimpleGit,
	remoteBranches: string[],
): Promise<string> {
	try {
		const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const match = headRef.match(/refs\/remotes\/origin\/(.+)/);
		if (match) {
			return match[1].trim();
		}
	} catch {
		if (remoteBranches.includes("master") && !remoteBranches.includes("main")) {
			return "master";
		}
	}
	return "main";
}

async function getCheckedOutBranches(
	git: SimpleGit,
	currentWorktreePath: string,
): Promise<Record<string, string>> {
	const checkedOutBranches: Record<string, string> = {};

	try {
		const worktreeList = await git.raw(["worktree", "list", "--porcelain"]);
		const lines = worktreeList.split("\n");
		let currentPath: string | null = null;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.substring(9).trim();
			} else if (line.startsWith("branch ")) {
				const branch = line.substring(7).trim().replace("refs/heads/", "");
				if (currentPath && currentPath !== currentWorktreePath) {
					checkedOutBranches[branch] = currentPath;
				}
			}
		}
	} catch {}

	return checkedOutBranches;
}

function getPersistedWorktree(worktreePath: string) {
	return localDb
		.select()
		.from(worktrees)
		.where(eq(worktrees.path, worktreePath))
		.get();
}

function persistWorktreeBranch(worktreePath: string, branch: string): void {
	const persistedWorktree = getPersistedWorktree(worktreePath);
	if (!persistedWorktree) {
		return;
	}

	const gitStatus = persistedWorktree.gitStatus
		? { ...persistedWorktree.gitStatus, branch }
		: null;

	localDb
		.update(worktrees)
		.set({
			branch,
			baseBranch: null,
			gitStatus,
		})
		.where(eq(worktrees.path, worktreePath))
		.run();
}

async function getSearchableRefs(
	git: SimpleGit,
	{
		search,
		includeTags,
	}: {
		search: string;
		includeTags: boolean;
	},
): Promise<SearchableRef[]> {
	const searchLower = search.trim().toLowerCase();
	const refMap = new Map<string, SearchableRef>();

	try {
		const localOutput = await git.raw([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short) %(committerdate:unix)",
			"refs/heads/",
		]);

		for (const line of localOutput.trim().split("\n")) {
			if (!line) continue;
			const lastSpaceIdx = line.lastIndexOf(" ");
			const name = line.substring(0, lastSpaceIdx);
			const timestamp = Number.parseInt(line.substring(lastSpaceIdx + 1), 10);
			if (!matchesSearch(name, searchLower)) continue;

			refMap.set(name, {
				name,
				ref: name,
				kind: "branch",
				lastCommitDate: Number.isNaN(timestamp) ? 0 : timestamp * 1000,
				isLocal: true,
				isRemote: false,
				checkedOutPath: null,
			});
		}
	} catch {}

	try {
		const remoteOutput = await git.raw([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short) %(committerdate:unix)",
			"refs/remotes/origin/",
		]);

		for (const line of remoteOutput.trim().split("\n")) {
			if (!line) continue;
			const lastSpaceIdx = line.lastIndexOf(" ");
			let name = line.substring(0, lastSpaceIdx);
			const timestamp = Number.parseInt(line.substring(lastSpaceIdx + 1), 10);
			if (name === "origin/HEAD") continue;
			if (name.startsWith("origin/")) {
				name = name.replace("origin/", "");
			}
			if (!matchesSearch(name, searchLower)) continue;

			const existing = refMap.get(name);
			if (existing) {
				existing.isRemote = true;
				existing.lastCommitDate = Math.max(
					existing.lastCommitDate,
					Number.isNaN(timestamp) ? 0 : timestamp * 1000,
				);
				continue;
			}

			refMap.set(name, {
				name,
				ref: `origin/${name}`,
				kind: "branch",
				lastCommitDate: Number.isNaN(timestamp) ? 0 : timestamp * 1000,
				isLocal: false,
				isRemote: true,
				checkedOutPath: null,
			});
		}
	} catch {}

	if (includeTags) {
		try {
			const tagOutput = await git.raw([
				"for-each-ref",
				"--sort=-creatordate",
				"--format=%(refname:short) %(creatordate:unix)",
				"refs/tags/",
			]);

			for (const line of tagOutput.trim().split("\n")) {
				if (!line) continue;
				const lastSpaceIdx = line.lastIndexOf(" ");
				const name = line.substring(0, lastSpaceIdx);
				const timestamp = Number.parseInt(line.substring(lastSpaceIdx + 1), 10);
				if (!matchesSearch(name, searchLower)) continue;

				refMap.set(`tag:${name}`, {
					name,
					ref: `refs/tags/${name}`,
					kind: "tag",
					lastCommitDate: Number.isNaN(timestamp) ? 0 : timestamp * 1000,
					isLocal: false,
					isRemote: false,
					checkedOutPath: null,
				});
			}
		} catch {}
	}

	return Array.from(refMap.values());
}

function matchesSearch(name: string, searchLower: string): boolean {
	return !searchLower || name.toLowerCase().includes(searchLower);
}
