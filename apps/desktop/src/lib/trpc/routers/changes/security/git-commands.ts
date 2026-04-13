import { runWithPostCheckoutHookTolerance } from "../../utils/git-hook-tolerance";
import { getCurrentBranch } from "../../workspaces/utils/git";
import { getSimpleGitWithShellPath } from "../../workspaces/utils/git-client";
import {
	assertRegisteredWorktree,
	assertValidGitPath,
} from "./path-validation";

/**
 * Git command helpers with semantic naming.
 *
 * Design principle: Different functions for different git semantics.
 * You can't accidentally use file checkout syntax for branch switching.
 *
 * Each function:
 * 1. Validates worktree is registered
 * 2. Validates paths/refs as appropriate
 * 3. Uses the correct git command syntax
 */

async function getGitWithShellPath(worktreePath: string) {
	return getSimpleGitWithShellPath(worktreePath);
}

function normalizeBranchName(branch: string): string {
	const trimmed = branch.trim();
	if (trimmed.startsWith("refs/heads/")) {
		return trimmed.slice("refs/heads/".length);
	}
	if (trimmed.startsWith("refs/remotes/origin/")) {
		return trimmed.slice("refs/remotes/origin/".length);
	}
	if (trimmed.startsWith("remotes/origin/")) {
		return trimmed.slice("remotes/origin/".length);
	}
	if (trimmed.startsWith("origin/")) {
		return trimmed.slice("origin/".length);
	}
	return trimmed;
}

function assertValidBranchName(branch: string): void {
	// Validate: reject anything that looks like a flag
	if (branch.startsWith("-")) {
		throw new Error("Invalid branch name: cannot start with -");
	}

	// Validate: reject empty branch names
	if (!branch.trim()) {
		throw new Error("Invalid branch name: cannot be empty");
	}
}

function assertValidStartPoint(startPoint: string): void {
	if (startPoint.startsWith("-")) {
		throw new Error("Invalid start point: cannot start with -");
	}

	if (!startPoint.trim()) {
		throw new Error("Invalid start point: cannot be empty");
	}
}

async function isCurrentBranch({
	worktreePath,
	expectedBranch,
}: {
	worktreePath: string;
	expectedBranch: string;
}): Promise<boolean> {
	try {
		const currentBranch = await getCurrentBranch(worktreePath);
		return currentBranch === expectedBranch;
	} catch {
		return false;
	}
}

/**
 * Switch to a branch.
 *
 * Uses `git switch` (unambiguous branch operation, git 2.23+).
 * Falls back to `git checkout <branch>` for older git versions.
 *
 * Note: `git checkout -- <branch>` is WRONG - that's file checkout syntax.
 */
export async function gitSwitchBranch(
	worktreePath: string,
	branch: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);
	const normalizedBranch = normalizeBranchName(branch);
	assertValidBranchName(normalizedBranch);

	const git = await getGitWithShellPath(worktreePath);

	await runWithPostCheckoutHookTolerance({
		context: `Switched branch to "${normalizedBranch}" in ${worktreePath}`,
		run: async () => {
			const localBranches = await git.branchLocal();
			if (localBranches.all.includes(normalizedBranch)) {
				try {
					await git.raw(["switch", normalizedBranch]);
					return;
				} catch (switchError) {
					const errorMessage = String(switchError);
					if (errorMessage.includes("is not a git command")) {
						await git.checkout(normalizedBranch);
						return;
					}
					throw switchError;
				}
			}

			const remoteBranches = await git.branch(["-r"]);
			const remoteBranch = `origin/${normalizedBranch}`;
			if (remoteBranches.all.includes(remoteBranch)) {
				try {
					await git.raw([
						"switch",
						"--track",
						"-c",
						normalizedBranch,
						remoteBranch,
					]);
					return;
				} catch (switchError) {
					const errorMessage = String(switchError);
					if (errorMessage.includes("is not a git command")) {
						await git.checkout([
							"-b",
							normalizedBranch,
							"--track",
							remoteBranch,
						]);
						return;
					}
					throw switchError;
				}
			}

			try {
				// Prefer `git switch` - unambiguous branch operation (git 2.23+)
				await git.raw(["switch", normalizedBranch]);
			} catch (switchError) {
				// Check if it's because `switch` command doesn't exist (old git < 2.23)
				// Git outputs: "git: 'switch' is not a git command. See 'git --help'."
				const errorMessage = String(switchError);
				if (errorMessage.includes("is not a git command")) {
					// Fallback for older git versions
					// Note: checkout WITHOUT -- is correct for branches
					await git.checkout(normalizedBranch);
				} else {
					throw switchError;
				}
			}
		},
		didSucceed: async () =>
			isCurrentBranch({ worktreePath, expectedBranch: normalizedBranch }),
	});
}

/**
 * Create and switch to a new branch, optionally from a specific ref.
 *
 * Uses `git switch -c` (or `git checkout -b` as a fallback).
 */
export async function gitCreateBranch(
	worktreePath: string,
	branch: string,
	startPoint?: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);
	assertValidBranchName(branch);
	if (startPoint) {
		assertValidStartPoint(startPoint);
	}

	const git = await getGitWithShellPath(worktreePath);

	await runWithPostCheckoutHookTolerance({
		context: `Created branch "${branch}" in ${worktreePath}`,
		run: async () => {
			try {
				await git.raw(
					startPoint
						? ["switch", "-c", branch, startPoint]
						: ["switch", "-c", branch],
				);
			} catch (switchError) {
				const errorMessage = String(switchError);
				if (errorMessage.includes("is not a git command")) {
					await git.checkout(
						startPoint ? ["-b", branch, startPoint] : ["-b", branch],
					);
					return;
				}
				throw switchError;
			}
		},
		didSucceed: async () =>
			isCurrentBranch({ worktreePath, expectedBranch: branch }),
	});
}

/**
 * Checkout (restore) a file path, discarding local changes.
 *
 * Uses `git checkout -- <path>` - the `--` is REQUIRED here
 * to indicate path mode (not branch mode).
 */
export async function gitCheckoutFile(
	worktreePath: string,
	filePath: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);
	assertValidGitPath(filePath);

	const git = await getGitWithShellPath(worktreePath);
	// `--` is correct here - we want path semantics
	await git.checkout(["--", filePath]);
}

/**
 * Stage a file for commit.
 *
 * Uses `git add -- <path>` - the `--` prevents paths starting
 * with `-` from being interpreted as flags.
 */
export async function gitStageFile(
	worktreePath: string,
	filePath: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);
	assertValidGitPath(filePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.add(["--", filePath]);
}

/**
 * Stage multiple files for commit in a single git command.
 *
 * Uses `git add -- <paths...>` to avoid index.lock races
 * when staging multiple files.
 */
export async function gitStageFiles(
	worktreePath: string,
	filePaths: string[],
): Promise<void> {
	if (filePaths.length === 0) {
		throw new Error("filePaths must not be empty");
	}
	assertRegisteredWorktree(worktreePath);
	for (const filePath of filePaths) {
		assertValidGitPath(filePath);
	}

	const git = await getGitWithShellPath(worktreePath);
	await git.add(["--", ...filePaths]);
}

/**
 * Unstage multiple files in a single git command.
 *
 * Uses `git reset HEAD -- <paths...>` to avoid index.lock races
 * when unstaging multiple files.
 */
export async function gitUnstageFiles(
	worktreePath: string,
	filePaths: string[],
): Promise<void> {
	if (filePaths.length === 0) {
		throw new Error("filePaths must not be empty");
	}
	assertRegisteredWorktree(worktreePath);
	for (const filePath of filePaths) {
		assertValidGitPath(filePath);
	}

	const git = await getGitWithShellPath(worktreePath);
	await git.reset(["HEAD", "--", ...filePaths]);
}

/**
 * Stage all changes for commit.
 *
 * Uses `git add -A` to stage all changes (new, modified, deleted).
 */
export async function gitStageAll(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.add("-A");
}

/**
 * Stage all changes to tracked files only.
 *
 * Uses `git add -u` so modifications and deletions of tracked files
 * are staged, but untracked files are left alone. Matches the
 * VS Code `git.smartCommitChanges: "tracked"` behavior.
 */
export async function gitStageTracked(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.add(["-u"]);
}

/**
 * Unstage a file (remove from staging area).
 *
 * Uses `git reset HEAD -- <path>` to unstage without
 * discarding changes.
 */
export async function gitUnstageFile(
	worktreePath: string,
	filePath: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);
	assertValidGitPath(filePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.reset(["HEAD", "--", filePath]);
}

/**
 * Unstage all files.
 *
 * Uses `git reset HEAD` to unstage all changes without
 * discarding them.
 */
export async function gitUnstageAll(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.reset(["HEAD"]);
}

/**
 * Discard all unstaged changes (modified and deleted files).
 *
 * Uses `git checkout -- .` to restore all tracked files to HEAD state.
 * Does NOT affect untracked files.
 */
export async function gitDiscardAllUnstaged(
	worktreePath: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.checkout(["--", "."]);
}

/**
 * Discard all staged changes by unstaging then discarding.
 *
 * Uses `git reset HEAD` followed by `git checkout -- .`.
 * Does NOT affect untracked files.
 */
export async function gitDiscardAllStaged(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.reset(["HEAD"]);
	await git.checkout(["--", "."]);
}

/**
 * Stash all tracked changes.
 *
 * Uses `git stash push` to save current work-in-progress.
 */
export async function gitStash(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.stash(["push"]);
}

/**
 * Stash all changes including untracked files.
 *
 * Uses `git stash push --include-untracked`.
 */
export async function gitStashIncludeUntracked(
	worktreePath: string,
): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.stash(["push", "--include-untracked"]);
}

/**
 * Pop the most recent stash.
 *
 * Uses `git stash pop` to apply and remove the top stash entry.
 * Throws if no stash exists or if there are conflicts.
 */
export async function gitStashPop(worktreePath: string): Promise<void> {
	assertRegisteredWorktree(worktreePath);

	const git = await getGitWithShellPath(worktreePath);
	await git.stash(["pop"]);
}
