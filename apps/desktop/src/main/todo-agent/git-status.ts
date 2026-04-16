import { execGitWithShellPath } from "lib/trpc/routers/workspaces/utils/git-client";

/**
 * Git inspection helpers scoped to a TODO session.
 *
 * All operations are read-only and routed through `execGitWithShellPath`
 * so shell PATH is resolved correctly (same helper the rest of the app's
 * git plumbing uses). The session's `startHeadSha` column — captured by
 * the supervisor the moment `runSession` begins — anchors "what this
 * session produced" vs. "what was already there", so commits the user
 * made before the session are never attributed to it.
 */

async function gitOut(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execGitWithShellPath(args, { cwd });
		return stdout;
	} catch {
		return "";
	}
}

/**
 * Does `sha` resolve to a commit object in `cwd`'s git dir? Used to
 * distinguish "no new commits" from "startHeadSha was orphaned by a
 * reset/rebase" — otherwise both look identical in the sidebar.
 */
async function gitRevExists(sha: string, cwd: string): Promise<boolean> {
	try {
		await execGitWithShellPath(
			["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
			{ cwd },
		);
		return true;
	} catch {
		return false;
	}
}

export async function getCurrentHeadSha(cwd: string): Promise<string | null> {
	const out = (await gitOut(["rev-parse", "HEAD"], cwd)).trim();
	return out || null;
}

export interface SessionGitCommit {
	sha: string;
	shortSha: string;
	subject: string;
	authorName: string;
	authorDate: string;
}

export type SessionGitFileStage = "staged" | "unstaged" | "untracked";

export interface SessionGitFile {
	path: string;
	stage: SessionGitFileStage;
	/** Raw git status letter — M / A / D / R / C / U / ? */
	code: string;
}

export interface SessionGitChangedFile {
	path: string;
	/** First letter of git's name-status code: A / M / D / R / C / T */
	code: string;
}

export interface SessionGitSnapshot {
	branch: string | null;
	startHeadSha: string | null;
	currentHeadSha: string | null;
	commits: SessionGitCommit[];
	workingTree: SessionGitFile[];
	/**
	 * Files whose contents differ between `startHeadSha` and HEAD
	 * (two-dot `git diff`). Populated regardless of whether HEAD is a
	 * descendant of startHeadSha, so branch switches / rebases still
	 * surface the cumulative session delta instead of silently
	 * rendering an empty sidebar.
	 */
	sessionFiles: SessionGitChangedFile[];
	/**
	 * True when `startHeadSha` is set but its commit object is no
	 * longer reachable (e.g. the branch was reset and the object was
	 * pruned, or a different repo was swapped in under the worktree).
	 * The UI uses this to show an explanatory message rather than a
	 * silently empty panel.
	 */
	startHeadUnreachable: boolean;
	ahead: number;
	behind: number;
}

const COMMIT_DELIM = "\x00";
const COMMIT_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join(COMMIT_DELIM);

export async function getSessionGitSnapshot(params: {
	cwd: string;
	startHeadSha: string | null;
}): Promise<SessionGitSnapshot> {
	const { cwd, startHeadSha } = params;

	const [branchOut, currentOut] = await Promise.all([
		gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		gitOut(["rev-parse", "HEAD"], cwd),
	]);
	const branch = branchOut.trim() || null;
	const currentHeadSha = currentOut.trim() || null;

	// Commits produced since the session started. Scoped to the range
	// `startHeadSha..HEAD`; when HEAD is not a descendant of
	// startHeadSha (branch switch / reset / rebase), this can validly
	// return an empty list, and we surface cumulative file-level
	// changes via `sessionFiles` below so the sidebar isn't empty.
	let commits: SessionGitCommit[] = [];
	let sessionFiles: SessionGitChangedFile[] = [];
	let startHeadUnreachable = false;
	if (startHeadSha && currentHeadSha && startHeadSha !== currentHeadSha) {
		const reachable = await gitRevExists(startHeadSha, cwd);
		if (!reachable) {
			startHeadUnreachable = true;
		} else {
			const logOut = await gitOut(
				[
					"log",
					`${startHeadSha}..${currentHeadSha}`,
					`--format=${COMMIT_FORMAT}`,
				],
				cwd,
			);
			commits = logOut
				.split("\n")
				.filter((l) => l.length > 0)
				.map((line) => {
					const [sha, shortSha, subject, authorName, authorDate] =
						line.split(COMMIT_DELIM);
					return {
						sha: sha ?? "",
						shortSha: shortSha ?? "",
						subject: subject ?? "",
						authorName: authorName ?? "",
						authorDate: authorDate ?? "",
					};
				});

			// `git diff --name-status -z A B` compares the two commits
			// directly (two-dot in diff has no range semantics), so it
			// works even when A and B are on divergent histories. This
			// is what lets the sidebar show the real session delta
			// when commits are zero but files were touched.
			const diffOut = await gitOut(
				["diff", "--name-status", "-z", startHeadSha, currentHeadSha],
				cwd,
			);
			sessionFiles = parseNameStatusNul(diffOut);
		}
	}

	// Working tree state via porcelain v1 for stable parsing.
	const statusOut = await gitOut(
		["status", "--porcelain=v1", "--untracked-files=all"],
		cwd,
	);
	const workingTree: SessionGitFile[] = [];
	const seen = new Set<string>();
	for (const line of statusOut.split("\n")) {
		if (line.length < 3) continue;
		const indexStatus = line[0] ?? " ";
		const wtStatus = line[1] ?? " ";
		const filePath = line.slice(3);
		const key = `${filePath}|${indexStatus}${wtStatus}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (indexStatus === "?" && wtStatus === "?") {
			workingTree.push({ path: filePath, stage: "untracked", code: "?" });
			continue;
		}
		if (indexStatus !== " " && indexStatus !== "?") {
			workingTree.push({
				path: filePath,
				stage: "staged",
				code: indexStatus,
			});
		}
		if (wtStatus !== " " && wtStatus !== "?") {
			workingTree.push({
				path: filePath,
				stage: "unstaged",
				code: wtStatus,
			});
		}
	}

	// Ahead/behind relative to upstream, if configured. Failure is
	// expected when no upstream is set, so swallow silently.
	let ahead = 0;
	let behind = 0;
	const rlOut = (
		await gitOut(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd)
	).trim();
	if (rlOut) {
		const parts = rlOut.split(/\s+/);
		if (parts.length === 2) {
			ahead = Number(parts[0]) || 0;
			behind = Number(parts[1]) || 0;
		}
	}

	return {
		branch,
		startHeadSha,
		currentHeadSha,
		commits,
		workingTree,
		sessionFiles,
		startHeadUnreachable,
		ahead,
		behind,
	};
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Standard entries are `<CODE>\0<path>\0`; rename/copy entries are
 * `<CODE><score>\0<oldPath>\0<newPath>\0` — we keep only the new path
 * and collapse the code to its first letter so the UI can render a
 * single badge per file.
 */
function parseNameStatusNul(raw: string): SessionGitChangedFile[] {
	const files: SessionGitChangedFile[] = [];
	const parts = raw.split("\0");
	let i = 0;
	while (i < parts.length) {
		const token = parts[i];
		if (!token) {
			i += 1;
			continue;
		}
		const letter = token[0] ?? "";
		if (letter === "R" || letter === "C") {
			const newPath = parts[i + 2];
			if (newPath) files.push({ path: newPath, code: letter });
			i += 3;
			continue;
		}
		const p = parts[i + 1];
		if (p) files.push({ path: p, code: letter || token });
		i += 2;
	}
	return files;
}

export type SessionDiffScope = "session" | "staged" | "unstaged" | "commit";

export async function getSessionFileDiff(params: {
	cwd: string;
	startHeadSha: string | null;
	path: string;
	scope: SessionDiffScope;
	commitSha?: string;
}): Promise<string> {
	const { cwd, startHeadSha, path, scope, commitSha } = params;
	const args: string[] = ["--no-pager", "diff", "--no-color"];

	switch (scope) {
		case "session":
			if (!startHeadSha) return "";
			args.push(`${startHeadSha}..HEAD`, "--", path);
			break;
		case "staged":
			args.push("--cached", "--", path);
			break;
		case "unstaged":
			args.push("--", path);
			break;
		case "commit": {
			if (!commitSha) return "";
			// Whole-commit diff: `git show --format= <sha>` returns just
			// the patch, no commit header. When the caller supplies a
			// path we scope to that file via `-- <path>`; when the path
			// is empty (UI selects a commit row, not a specific file),
			// we must NOT append an empty pathspec or Git rejects it
			// with "empty string is not a valid pathspec" and the diff
			// silently disappears from the sidebar.
			const showArgs = [
				"--no-pager",
				"show",
				"--no-color",
				"--format=",
				commitSha,
			];
			if (path && path.length > 0) {
				showArgs.push("--", path);
			}
			return gitOut(showArgs, cwd);
		}
	}

	return gitOut(args, cwd);
}
