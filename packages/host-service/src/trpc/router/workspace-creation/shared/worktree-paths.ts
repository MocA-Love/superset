import { resolve, sep } from "node:path";
import { TRPCError } from "@trpc/server";

// FORK NOTE: worktrees are kept under <repoPath>/.worktrees/<branch>
// (repo-local, not global ~/.superset/worktrees). This keeps worktrees
// co-located with the repo for editors, file watchers, and ignore rules.
// Upstream split uses ~/.superset/worktrees/<projectId>/<branch>; we
// intentionally diverge to preserve existing workspace paths.
export function safeResolveWorktreePath(
	repoPath: string,
	branchName: string,
): string {
	const worktreesRoot = resolve(repoPath, ".worktrees");
	const worktreePath = resolve(worktreesRoot, branchName);
	if (
		worktreePath !== worktreesRoot &&
		!worktreePath.startsWith(worktreesRoot + sep)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid branch name: path traversal detected (${branchName})`,
		});
	}
	return worktreePath;
}
