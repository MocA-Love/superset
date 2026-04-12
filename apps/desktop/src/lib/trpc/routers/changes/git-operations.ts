import {
	generateTitleFromMessage,
	generateTitleFromMessageWithStreamingModel,
} from "@superset/chat/server/desktop";
import { TRPCError } from "@trpc/server";
import { callSmallModel } from "lib/ai/call-small-model";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	setBranchPullRequestBaseRepoConfig,
	unsetBranchPullRequestBaseRepoConfig,
} from "../workspaces/utils/base-branch-config";
import { getCurrentBranch } from "../workspaces/utils/git";
import { getSimpleGitWithShellPath } from "../workspaces/utils/git-client";
import {
	type GitOperationWarning,
	GitSyncStageError,
} from "./git-operation-types";
import {
	isNoPullRequestFoundMessage,
	isUpstreamMissingError,
} from "./git-utils";
import { assertRegisteredWorktree } from "./security/path-validation";
import {
	fetchCurrentBranch,
	getTrackingBranchStatus,
	hasUpstreamBranch,
	isNonFastForwardPushError,
	pushCurrentBranch,
	pushWithResolvedUpstream,
} from "./utils/git-push";
import { mergePullRequest } from "./utils/merge-pull-request";
import {
	buildNewPullRequestUrl,
	findExistingOpenPRUrl,
	resolvePullRequestBaseRepoSelection,
} from "./utils/pull-request-discovery";
import { normalizeGitHubRepoUrl } from "./utils/pull-request-url";
import { clearStatusCacheForWorktree } from "./utils/status-cache";
import { clearWorktreeStatusCaches } from "./utils/worktree-status-caches";

export { isUpstreamMissingError };

async function getGitWithShellPath(worktreePath: string) {
	return getSimpleGitWithShellPath(worktreePath);
}

async function getLocalBranchOrThrow({
	worktreePath,
	action,
}: {
	worktreePath: string;
	action: string;
}): Promise<string> {
	const branch = await getCurrentBranch(worktreePath);
	if (!branch) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Cannot ${action} from detached HEAD. Please checkout a branch and try again.`,
		});
	}
	return branch;
}

export const createGitOperationsRouter = () => {
	return router({
		// NOTE: saveFile is defined in file-contents.ts with hardened path validation
		// Do NOT add saveFile here - it would overwrite the secure version

		commit: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					message: z.string(),
					/** Pass --no-verify to bypass pre-commit / commit-msg hooks. */
					skipHooks: z.boolean().optional(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; hash: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const options = input.skipHooks ? ["--no-verify"] : undefined;
					const result = await git.commit(input.message, options);
					clearStatusCacheForWorktree(input.worktreePath);
					return { success: true, hash: result.commit };
				},
			),

		push: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					setUpstream: z.boolean().optional(),
				}),
			)
			.mutation(
				async ({
					input,
				}): Promise<{
					success: boolean;
					warnings: GitOperationWarning[];
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const hasUpstream = await hasUpstreamBranch(git);
					const localBranch = await getLocalBranchOrThrow({
						worktreePath: input.worktreePath,
						action: "push",
					});
					const warnings: GitOperationWarning[] = [];

					if (input.setUpstream && !hasUpstream) {
						await pushWithResolvedUpstream({
							git,
							worktreePath: input.worktreePath,
							localBranch,
						});
						warnings.push({
							kind: "auto-published-upstream",
							branch: localBranch,
						});
					} else {
						await pushCurrentBranch({
							git,
							worktreePath: input.worktreePath,
							localBranch,
						});
					}

					try {
						await fetchCurrentBranch(git, input.worktreePath);
					} catch (fetchError) {
						const message =
							fetchError instanceof Error
								? fetchError.message
								: String(fetchError);
						console.warn(
							"[git/push] post-push fetch failed (non-fatal):",
							message,
						);
						warnings.push({ kind: "post-push-fetch-failed", message });
					}

					clearStatusCacheForWorktree(input.worktreePath);
					return { success: true, warnings };
				},
			),

		pull: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const git = await getGitWithShellPath(input.worktreePath);
				try {
					await git.pull(["--rebase"]);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isUpstreamMissingError(message)) {
						throw new Error(
							"No upstream branch to pull from. The remote branch may have been deleted.",
						);
					}
					throw error;
				}
				clearStatusCacheForWorktree(input.worktreePath);
				return { success: true };
			}),

		sync: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(
				async ({
					input,
				}): Promise<{
					success: boolean;
					warnings: GitOperationWarning[];
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const warnings: GitOperationWarning[] = [];

					try {
						await git.pull(["--rebase"]);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						if (isUpstreamMissingError(message)) {
							const localBranch = await getLocalBranchOrThrow({
								worktreePath: input.worktreePath,
								action: "push",
							});
							await pushWithResolvedUpstream({
								git,
								worktreePath: input.worktreePath,
								localBranch,
							});
							warnings.push({
								kind: "auto-published-upstream",
								branch: localBranch,
							});
							try {
								await fetchCurrentBranch(git, input.worktreePath);
							} catch (fetchError) {
								const fetchMessage =
									fetchError instanceof Error
										? fetchError.message
										: String(fetchError);
								warnings.push({
									kind: "post-push-fetch-failed",
									message: fetchMessage,
								});
							}
							clearStatusCacheForWorktree(input.worktreePath);
							return { success: true, warnings };
						}
						throw new GitSyncStageError("pull", error);
					}

					const localBranch = await getLocalBranchOrThrow({
						worktreePath: input.worktreePath,
						action: "push",
					});
					try {
						await pushCurrentBranch({
							git,
							worktreePath: input.worktreePath,
							localBranch,
						});
					} catch (pushError) {
						throw new GitSyncStageError("push", pushError);
					}
					try {
						await fetchCurrentBranch(git, input.worktreePath);
					} catch (fetchError) {
						const fetchMessage =
							fetchError instanceof Error
								? fetchError.message
								: String(fetchError);
						warnings.push({
							kind: "post-push-fetch-failed",
							message: fetchMessage,
						});
					}
					clearStatusCacheForWorktree(input.worktreePath);
					return { success: true, warnings };
				},
			),

		fetch: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);
				const git = await getGitWithShellPath(input.worktreePath);
				await fetchCurrentBranch(git, input.worktreePath);
				clearStatusCacheForWorktree(input.worktreePath);
				return { success: true };
			}),

		createPR: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					allowOutOfDate: z.boolean().optional().default(false),
					baseRepoUrl: z.string().url().optional(),
				}),
			)
			.mutation(
				async ({
					input,
				}): Promise<{ success: boolean; url: string; isExisting: boolean }> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const branch = await getLocalBranchOrThrow({
						worktreePath: input.worktreePath,
						action: "create a pull request",
					});
					const normalizedBaseRepoUrl = input.baseRepoUrl
						? normalizeGitHubRepoUrl(input.baseRepoUrl)
						: null;
					if (normalizedBaseRepoUrl) {
						const selection = await resolvePullRequestBaseRepoSelection({
							worktreePath: input.worktreePath,
							branch,
							preferredBaseRepoUrl: normalizedBaseRepoUrl,
						});
						if (selection.selectedBaseRepoUrl === normalizedBaseRepoUrl) {
							await setBranchPullRequestBaseRepoConfig({
								repoPath: input.worktreePath,
								branch,
								baseRepoUrl: normalizedBaseRepoUrl,
							});
						}
					}

					const trackingStatus = await getTrackingBranchStatus(git);
					const hasUpstream = trackingStatus.hasUpstream;
					const isBehindUpstream =
						trackingStatus.hasUpstream && trackingStatus.pullCount > 0;
					const hasUnpushedCommits =
						trackingStatus.hasUpstream && trackingStatus.pushCount > 0;

					if (isBehindUpstream && !input.allowOutOfDate) {
						const commitLabel =
							trackingStatus.pullCount === 1 ? "commit" : "commits";
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: `Branch is behind upstream by ${trackingStatus.pullCount} ${commitLabel}. Pull/rebase first, or continue anyway.`,
						});
					}

					// Ensure remote branch exists and local commits are available on remote before PR create.
					if (!hasUpstream) {
						await pushWithResolvedUpstream({
							git,
							worktreePath: input.worktreePath,
							localBranch: branch,
						});
					} else {
						try {
							await pushCurrentBranch({
								git,
								worktreePath: input.worktreePath,
								localBranch: branch,
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							if (
								input.allowOutOfDate &&
								isBehindUpstream &&
								hasUnpushedCommits &&
								isNonFastForwardPushError(message)
							) {
								throw new TRPCError({
									code: "PRECONDITION_FAILED",
									message:
										"Branch has local commits but is behind upstream. Pull/rebase first so local commits can be pushed before creating a PR.",
								});
							}
							throw error;
						}
					}

					const existingPRUrl = await findExistingOpenPRUrl(input.worktreePath);
					if (existingPRUrl) {
						await fetchCurrentBranch(git, input.worktreePath);
						clearWorktreeStatusCaches(input.worktreePath);
						return { success: true, url: existingPRUrl, isExisting: true };
					}

					try {
						const url = await buildNewPullRequestUrl(
							input.worktreePath,
							git,
							branch,
							normalizedBaseRepoUrl,
						);
						await fetchCurrentBranch(git, input.worktreePath);
						clearWorktreeStatusCaches(input.worktreePath);

						return { success: true, url, isExisting: false };
					} catch (error) {
						// If creation reports branch/tracking mismatch but an open PR exists,
						// recover by opening that existing PR instead of failing.
						const recoveredPRUrl = await findExistingOpenPRUrl(
							input.worktreePath,
						);
						if (recoveredPRUrl) {
							await fetchCurrentBranch(git, input.worktreePath);
							clearWorktreeStatusCaches(input.worktreePath);
							return {
								success: true,
								url: recoveredPRUrl,
								isExisting: true,
							};
						}
						throw error;
					}
				},
			),

		resolveCreatePRBaseOptions: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(
				async ({
					input,
				}): Promise<{
					baseRepoOptions: Awaited<
						ReturnType<typeof resolvePullRequestBaseRepoSelection>
					>["baseRepoOptions"];
					selectedBaseRepoUrl: string | null;
					requiresChoice: boolean;
				}> => {
					assertRegisteredWorktree(input.worktreePath);

					const branch = await getLocalBranchOrThrow({
						worktreePath: input.worktreePath,
						action: "create a pull request",
					});
					const selection = await resolvePullRequestBaseRepoSelection({
						worktreePath: input.worktreePath,
						branch,
					});

					return {
						...selection,
						requiresChoice:
							selection.selectedBaseRepoUrl === null &&
							selection.baseRepoOptions.length > 1,
					};
				},
			),

		updatePullRequestBaseRepo: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					baseRepoUrl: z.string().url().nullable(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const branch = await getLocalBranchOrThrow({
					worktreePath: input.worktreePath,
					action: "update the pull request base repository",
				});
				const normalizedBaseRepoUrl = input.baseRepoUrl
					? normalizeGitHubRepoUrl(input.baseRepoUrl)
					: null;

				if (normalizedBaseRepoUrl) {
					const selection = await resolvePullRequestBaseRepoSelection({
						worktreePath: input.worktreePath,
						branch,
						preferredBaseRepoUrl: normalizedBaseRepoUrl,
					});
					if (selection.selectedBaseRepoUrl !== normalizedBaseRepoUrl) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invalid pull request base repository selection.",
						});
					}

					await setBranchPullRequestBaseRepoConfig({
						repoPath: input.worktreePath,
						branch,
						baseRepoUrl: normalizedBaseRepoUrl,
					});
				} else {
					await unsetBranchPullRequestBaseRepoConfig({
						repoPath: input.worktreePath,
						branch,
					});
				}

				clearWorktreeStatusCaches(input.worktreePath);
				return { success: true };
			}),

		mergePR: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					strategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; mergedAt?: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					try {
						return await mergePullRequest(input);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error("[git/mergePR] Failed to merge PR:", message);

						if (isNoPullRequestFoundMessage(message)) {
							throw new TRPCError({
								code: "NOT_FOUND",
								message: "No pull request found for this branch",
							});
						}
						if (
							message === "PR is already merged" ||
							message === "PR is closed and cannot be merged"
						) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message,
							});
						}
						if (
							message.includes("not mergeable") ||
							message.includes("blocked")
						) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message:
									"PR cannot be merged. Check for merge conflicts or required status checks.",
							});
						}
						throw new TRPCError({
							code: "INTERNAL_SERVER_ERROR",
							message: `Failed to merge PR: ${message}`,
						});
					}
				},
			),

		generateCommitMessage: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(async ({ input }): Promise<{ message: string | null }> => {
				assertRegisteredWorktree(input.worktreePath);

				const git = await getGitWithShellPath(input.worktreePath);

				// ---------------------------------------------------------------------------
				// Hierarchical summarization (gptcommit-style):
				//   Phase 1 — Summarize each changed file independently (parallel)
				//   Phase 2 — Combine all summaries into a single commit message
				// This avoids token-limit issues with large diffs and produces the
				// most accurate results because no file content is truncated.
				// ---------------------------------------------------------------------------

				// Collect per-file diffs from staged, unstaged, and untracked sources
				const [stagedStat, unstagedStat, statusSummary] = await Promise.all([
					git.diff(["--cached", "--stat", "--stat-width=200"]),
					git.diff(["--stat", "--stat-width=200"]),
					git.status(),
				]);

				interface FileChange {
					path: string;
					source: "staged" | "unstaged" | "untracked";
					diff: string | null; // null for untracked / binary
				}

				const files: FileChange[] = [];

				// Staged files
				const stagedFiles = statusSummary.staged;
				if (stagedFiles.length > 0) {
					const diffs = await Promise.all(
						stagedFiles.map((f) =>
							git
								.diff(["--cached", "--", f])
								.then((d) => d.trim() || null)
								.catch(() => null),
						),
					);
					for (let i = 0; i < stagedFiles.length; i++) {
						files.push({
							path: stagedFiles[i],
							source: "staged",
							diff: diffs[i],
						});
					}
				}

				// Unstaged files (modified tracked files)
				const unstagedFiles = statusSummary.modified.filter(
					(f) => !stagedFiles.includes(f),
				);
				if (unstagedFiles.length > 0) {
					const diffs = await Promise.all(
						unstagedFiles.map((f) =>
							git
								.diff(["--", f])
								.then((d) => d.trim() || null)
								.catch(() => null),
						),
					);
					for (let i = 0; i < unstagedFiles.length; i++) {
						files.push({
							path: unstagedFiles[i],
							source: "unstaged",
							diff: diffs[i],
						});
					}
				}

				// Untracked files (new, not yet added)
				for (const f of statusSummary.not_added) {
					files.push({ path: f, source: "untracked", diff: null });
				}

				if (files.length === 0) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No changes to generate a commit message for.",
					});
				}

				// Skip patterns — files that waste tokens without useful context
				const SKIP_PATTERNS = [
					/\.lock$/,
					/package-lock\.json$/,
					/bun\.lock(b)?$/,
					/yarn\.lock$/,
					/pnpm-lock\.yaml$/,
					/\.min\.(js|css)$/,
				];
				const isBinary = (path: string) =>
					/\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|mp[34]|mov|zip|tar|gz|pdf)$/i.test(
						path,
					);

				const summarizableFiles: FileChange[] = [];
				const skippedFileNames: string[] = [];

				for (const f of files) {
					if (SKIP_PATTERNS.some((p) => p.test(f.path)) || isBinary(f.path)) {
						skippedFileNames.push(f.path);
					} else {
						summarizableFiles.push(f);
					}
				}

				// ---- Phase 1: Summarize each file in parallel -------------------------

				const PHASE1_INSTRUCTIONS =
					"与えられたdiffを1行の日本語で要約してください。何が変わったかを簡潔に。要約のみを返してください。";
				const PER_FILE_MAX_CHARS = 4000;

				const summarizeFile = async (f: FileChange): Promise<string> => {
					// Files without diff (untracked) — just report the file name
					if (!f.diff) {
						return `${f.path}: 新規ファイル`;
					}

					// Small diffs — no need to call LLM, include directly
					if (f.diff.length < 300) {
						return `${f.path}: ${f.diff}`;
					}

					const truncatedDiff =
						f.diff.length > PER_FILE_MAX_CHARS
							? `${f.diff.slice(0, PER_FILE_MAX_CHARS)}\n... (truncated)`
							: f.diff;

					const { result } = await callSmallModel<string>({
						invoke: async ({
							model,
							credentials,
							providerId,
							providerName,
						}) => {
							if (providerId === "openai" && credentials.kind === "oauth") {
								return generateTitleFromMessageWithStreamingModel({
									message: `File: ${f.path}\n\n${truncatedDiff}`,
									model: model as never,
									instructions: PHASE1_INSTRUCTIONS,
								});
							}
							return generateTitleFromMessage({
								message: `File: ${f.path}\n\n${truncatedDiff}`,
								agentModel: model,
								agentId: `commit-file-summary-${providerId}`,
								agentName: "File Summarizer",
								instructions: PHASE1_INSTRUCTIONS,
								tracingContext: {
									surface: "commit-file-summary",
									provider: providerName,
								},
							});
						},
					});

					return `${f.path}: ${result ?? "変更あり"}`;
				};

				const fileSummaries = await Promise.all(
					summarizableFiles.map(summarizeFile),
				);

				// ---- Phase 2: Generate final commit message from summaries ------------

				let phase2Input = "変更されたファイルの要約:\n";
				phase2Input += fileSummaries.join("\n");
				if (skippedFileNames.length > 0) {
					phase2Input += `\n\nその他の変更ファイル（依存関係・バイナリ）:\n${skippedFileNames.join("\n")}`;
				}
				phase2Input += `\n\n変更の統計:\n${stagedStat || unstagedStat || "(統計なし)"}`;

				const PHASE2_PROMPT = `以下のファイル変更要約に基づいて、簡潔なconventional commitメッセージを日本語で生成してください。\nフォーマット: type(scope): 日本語の説明\ntypeは feat, fix, refactor, chore, docs, test, style, perf のいずれか。\n72文字以内。コミットメッセージのみを返してください。\n\n${phase2Input}`;
				const PHASE2_INSTRUCTIONS =
					"日本語で簡潔なconventional commitメッセージを生成してください。コミットメッセージの行のみを返してください。";

				const { result, attempts } = await callSmallModel<string>({
					invoke: async ({ model, credentials, providerId, providerName }) => {
						if (providerId === "openai" && credentials.kind === "oauth") {
							return generateTitleFromMessageWithStreamingModel({
								message: PHASE2_PROMPT,
								model: model as never,
								instructions: PHASE2_INSTRUCTIONS,
							});
						}

						return generateTitleFromMessage({
							message: PHASE2_PROMPT,
							agentModel: model,
							agentId: `commit-message-${providerId}`,
							agentName: "Commit Message Generator",
							instructions: PHASE2_INSTRUCTIONS,
							tracingContext: {
								surface: "commit-message-generation",
								provider: providerName,
							},
						});
					},
				});

				if (!result) {
					console.warn(
						"[generateCommitMessage] All providers failed:",
						JSON.stringify(attempts, null, 2),
					);
				}

				return { message: result };
			}),

		forceUnlockIndex: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(
				async ({
					input,
				}): Promise<{ removed: boolean; path: string | null }> => {
					assertRegisteredWorktree(input.worktreePath);
					const { isAbsolute, resolve } = await import("node:path");
					const { stat, unlink } = await import("node:fs/promises");

					// Resolve the *real* git-dir. For linked worktrees ".git" is a
					// file that points at ".git/worktrees/<name>", where the actual
					// index.lock lives. Falling back to "<worktree>/.git" is fine for
					// the non-linked case.
					const git = await getGitWithShellPath(input.worktreePath);
					let gitDir: string;
					try {
						const raw = (
							await git.raw(["rev-parse", "--git-dir"])
						).trim();
						gitDir = isAbsolute(raw) ? raw : resolve(input.worktreePath, raw);
					} catch {
						gitDir = resolve(input.worktreePath, ".git");
					}

					const candidates = [
						resolve(gitDir, "index.lock"),
						resolve(gitDir, "HEAD.lock"),
						resolve(gitDir, "shallow.lock"),
					];
					for (const candidate of candidates) {
						// stat: only swallow ENOENT (file not present). Other stat
						// errors (EACCES, EPERM, EIO) are real failures and should
						// surface so the user learns why the unlock did not run.
						try {
							await stat(candidate);
						} catch (statError) {
							const code = (statError as NodeJS.ErrnoException).code;
							if (code === "ENOENT") continue;
							throw new TRPCError({
								code: "INTERNAL_SERVER_ERROR",
								message: `Failed to inspect lock file ${candidate}: ${
									statError instanceof Error
										? statError.message
										: String(statError)
								}`,
							});
						}
						// unlink failures (EACCES/EPERM when the file exists but can
						// not be removed) are propagated verbatim — never swallowed.
						try {
							await unlink(candidate);
						} catch (unlinkError) {
							throw new TRPCError({
								code: "INTERNAL_SERVER_ERROR",
								message: `Failed to remove lock file ${candidate}: ${
									unlinkError instanceof Error
										? unlinkError.message
										: String(unlinkError)
								}`,
							});
						}
						clearStatusCacheForWorktree(input.worktreePath);
						return { removed: true, path: candidate };
					}
					return { removed: false, path: null };
				},
			),
	});
};
