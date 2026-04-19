import { execGitWithShellPath } from "lib/trpc/routers/workspaces/utils/git-client";

export type ScheduleSyncResult =
	| { kind: "ok"; checkedOut: string }
	| { kind: "dirty"; message: string }
	| { kind: "error"; message: string };

async function runGit(
	args: string[],
	cwd: string,
	timeout = 60_000,
): Promise<{ stdout: string; stderr: string }> {
	const result = await execGitWithShellPath(args, { cwd, timeout });
	return { stdout: result.stdout, stderr: result.stderr };
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await runGit(["status", "--porcelain"], cwd, 15_000);
		return stdout.trim().length > 0;
	} catch {
		// If status itself fails we can't be sure — treat as dirty to
		// avoid destructive actions.
		return true;
	}
}

async function resolveDefaultBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await runGit(
			["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
			cwd,
			10_000,
		);
		const ref = stdout.trim();
		const defaultBranch = ref.replace(/^origin\//, "");
		if (defaultBranch) {
			return defaultBranch;
		}
	} catch {}
	// Fallbacks — conservative default.
	return "main";
}

/**
 * Opt-in "freshen the main repo before firing a schedule". Keeps the
 * scope deliberately narrow:
 *
 *   - `git fetch origin`
 *   - abort if the working tree has uncommitted changes (never stash —
 *     we refuse to touch the user's work)
 *   - `git checkout <default>`
 *   - `git pull --ff-only origin <default>`
 *
 * Called only when `todoSchedule.autoSyncBeforeFire` is true and the
 * schedule is firing on the project main repo (no specific worktree).
 */
export async function autoSyncProjectMain(
	cwd: string,
): Promise<ScheduleSyncResult> {
	try {
		await runGit(["fetch", "origin"], cwd, 120_000);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "git fetch が失敗しました";
		return { kind: "error", message };
	}

	if (await hasUncommittedChanges(cwd)) {
		return {
			kind: "dirty",
			message: "未コミット変更があるため main を更新できませんでした",
		};
	}

	const defaultBranch = await resolveDefaultBranch(cwd);

	try {
		await runGit(["checkout", defaultBranch], cwd, 60_000);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: `git checkout ${defaultBranch} が失敗しました`;
		return { kind: "error", message };
	}

	try {
		await runGit(["pull", "--ff-only", "origin", defaultBranch], cwd, 120_000);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "git pull が失敗しました";
		return { kind: "error", message };
	}

	return { kind: "ok", checkedOut: defaultBranch };
}
