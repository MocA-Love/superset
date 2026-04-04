import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { worktrees } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
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
import { clearWorktreeStatusCaches } from "./utils/worktree-status-caches";

const DEFAULT_REF_SEARCH_LIMIT = 50;
const MAX_REF_SEARCH_LIMIT = 200;
const GIT_PROGRESS_OPERATIONS = [
	{ kind: "merge", path: "MERGE_HEAD" },
	{ kind: "cherry-pick", path: "CHERRY_PICK_HEAD" },
	{ kind: "revert", path: "REVERT_HEAD" },
	{ kind: "bisect", path: "BISECT_LOG" },
] as const;

type BranchProgressOperation =
	| "merge"
	| "rebase"
	| "cherry-pick"
	| "revert"
	| "bisect";

type SearchableRef = {
	name: string;
	displayName: string;
	ref: string;
	kind: "branch" | "tag";
	scope: "local" | "remote" | "tag";
	lastCommitDate: number;
	shortHash: string | null;
	authorName: string | null;
	subject: string | null;
	checkedOutPath: string | null;
};

type ParsedRefEntry = {
	name: string;
	shortHash: string | null;
	authorName: string | null;
	subject: string | null;
	lastCommitDate: number;
};

const REF_FIELD_SEPARATOR = "\u001f";
const REF_RECORD_SEPARATOR = "\u001e";

function normalizeBranchRef(branch: string): string {
	if (branch.startsWith("refs/heads/")) {
		return branch.slice("refs/heads/".length);
	}
	if (branch.startsWith("refs/remotes/origin/")) {
		return branch.slice("refs/remotes/origin/".length);
	}
	if (branch.startsWith("remotes/origin/")) {
		return branch.slice("remotes/origin/".length);
	}
	return branch;
}

async function assertWorktreePathExists(worktreePath: string): Promise<void> {
	if (await pathExists(worktreePath)) return;
	throw new TRPCError({
		code: "NOT_FOUND",
		message: `Worktree path does not exist: ${worktreePath}`,
	});
}

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
					await assertWorktreePathExists(input.worktreePath);

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
						.filter((ref) => ref.kind === "branch" && ref.scope === "remote")
						.map((ref) => ref.name);
					const defaultBranch = await getDefaultBranch(git, remoteBranchNames);

					const sortedRefs = refs.sort((a, b) => {
						if (a.kind !== b.kind) return a.kind === "branch" ? -1 : 1;
						if (a.kind === "branch" && b.kind === "branch") {
							if (a.name === currentBranch) return -1;
							if (b.name === currentBranch) return 1;
							if (a.name === defaultBranch) return -1;
							if (b.name === defaultBranch) return 1;
							if (a.scope !== b.scope) return a.scope === "local" ? -1 : 1;
						}
						if (a.lastCommitDate !== b.lastCommitDate) {
							return b.lastCommitDate - a.lastCommitDate;
						}
						return a.displayName.localeCompare(b.displayName);
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
				await assertWorktreePathExists(input.worktreePath);
				const branch = normalizeBranchRef(input.branch);
				await gitSwitchBranch(input.worktreePath, branch);
				const currentBranch =
					(await getCurrentBranch(input.worktreePath)) ?? branch;
				persistWorktreeBranch(input.worktreePath, currentBranch);

				clearWorktreeStatusCaches(input.worktreePath);
				return { success: true };
			}),

		getBranchGuardState: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.query(
				async ({
					input,
				}): Promise<{
					operationInProgress: BranchProgressOperation | null;
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getSimpleGitWithShellPath(input.worktreePath);

					return {
						operationInProgress: await detectGitProgressOperation(
							git,
							input.worktreePath,
						),
					};
				},
			),

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

					clearWorktreeStatusCaches(input.worktreePath);
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

				clearWorktreeStatusCaches(input.worktreePath);
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function detectGitProgressOperation(
	git: SimpleGit,
	worktreePath: string,
): Promise<BranchProgressOperation | null> {
	let gitDirPath: string;

	try {
		const gitDir = (await git.revparse(["--git-dir"])).trim();
		gitDirPath = resolve(worktreePath, gitDir);
	} catch {
		return null;
	}

	if (
		(await pathExists(join(gitDirPath, "rebase-merge"))) ||
		(await pathExists(join(gitDirPath, "rebase-apply")))
	) {
		return "rebase";
	}

	for (const candidate of GIT_PROGRESS_OPERATIONS) {
		if (await pathExists(join(gitDirPath, candidate.path))) {
			return candidate.kind;
		}
	}

	return null;
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
	const refs: SearchableRef[] = [];

	try {
		for (const localBranch of await getRefEntries(git, {
			refPath: "refs/heads/",
			dateField: "committerdate",
			authorField: "authorname",
		})) {
			if (!matchesSearch(localBranch, searchLower)) continue;

			refs.push({
				name: localBranch.name,
				displayName: localBranch.name,
				ref: localBranch.name,
				kind: "branch",
				scope: "local",
				lastCommitDate: localBranch.lastCommitDate,
				shortHash: localBranch.shortHash,
				authorName: localBranch.authorName,
				subject: localBranch.subject,
				checkedOutPath: null,
			});
		}
	} catch {}

	try {
		for (const remoteBranch of await getRefEntries(git, {
			refPath: "refs/remotes/origin/",
			dateField: "committerdate",
			authorField: "authorname",
		})) {
			if (remoteBranch.name === "origin/HEAD") continue;
			const canonicalName = remoteBranch.name.startsWith("origin/")
				? remoteBranch.name.replace("origin/", "")
				: remoteBranch.name;
			const displayName = remoteBranch.name.startsWith("origin/")
				? remoteBranch.name
				: `origin/${remoteBranch.name}`;
			if (
				!matchesSearch(
					{ ...remoteBranch, name: canonicalName, displayName },
					searchLower,
				)
			) {
				continue;
			}

			refs.push({
				name: canonicalName,
				displayName,
				ref: displayName,
				kind: "branch",
				scope: "remote",
				lastCommitDate: remoteBranch.lastCommitDate,
				shortHash: remoteBranch.shortHash,
				authorName: remoteBranch.authorName,
				subject: remoteBranch.subject,
				checkedOutPath: null,
			});
		}
	} catch {}

	if (includeTags) {
		try {
			for (const tag of await getRefEntries(git, {
				refPath: "refs/tags/",
				dateField: "creatordate",
				authorField: "creatorname",
			})) {
				if (!matchesSearch(tag, searchLower)) continue;

				refs.push({
					name: tag.name,
					displayName: tag.name,
					ref: `refs/tags/${tag.name}`,
					kind: "tag",
					scope: "tag",
					lastCommitDate: tag.lastCommitDate,
					shortHash: tag.shortHash,
					authorName: tag.authorName,
					subject: tag.subject,
					checkedOutPath: null,
				});
			}
		} catch {}
	}

	return refs;
}

async function getRefEntries(
	git: SimpleGit,
	{
		refPath,
		dateField,
		authorField,
	}: {
		refPath: string;
		dateField: "committerdate" | "creatordate";
		authorField: "authorname" | "creatorname";
	},
): Promise<ParsedRefEntry[]> {
	const output = await git.raw([
		"for-each-ref",
		`--sort=-${dateField}`,
		`--format=%(refname:short)${REF_FIELD_SEPARATOR}%(objectname:short)${REF_FIELD_SEPARATOR}%(${authorField})${REF_FIELD_SEPARATOR}%(subject)${REF_FIELD_SEPARATOR}%(${dateField}:unix)${REF_RECORD_SEPARATOR}`,
		refPath,
	]);

	return output
		.split(REF_RECORD_SEPARATOR)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [
				name = "",
				shortHash = "",
				authorName = "",
				subject = "",
				timestamp = "0",
			] = line.split(REF_FIELD_SEPARATOR);
			const parsedTimestamp = Number.parseInt(timestamp, 10);

			return {
				name,
				shortHash: normalizeRefField(shortHash),
				authorName: normalizeRefField(authorName),
				subject: normalizeRefField(subject),
				lastCommitDate: Number.isNaN(parsedTimestamp)
					? 0
					: parsedTimestamp * 1000,
			};
		})
		.filter((entry) => entry.name.length > 0);
}

function normalizeRefField(value: string): string | null {
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function matchesSearch(
	ref:
		| ParsedRefEntry
		| (ParsedRefEntry & { displayName?: string })
		| SearchableRef,
	searchLower: string,
): boolean {
	if (!searchLower) {
		return true;
	}

	return [
		ref.name,
		"displayName" in ref ? ref.displayName : null,
		ref.shortHash,
		ref.authorName,
		ref.subject,
	]
		.filter((value): value is string => Boolean(value))
		.some((value) => value.toLowerCase().includes(searchLower));
}
