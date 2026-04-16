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
	} catch (err) {
		// Log instead of swallowing silently so broken git queries surface
		// in the main-process log. The caller still treats empty stdout as
		// "no data", so the UX is unchanged on real failures.
		console.warn("[todo-agent/git-status] git command failed", {
			args,
			cwd,
			err: err instanceof Error ? err.message : String(err),
		});
		return "";
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

export interface SessionGitSnapshot {
	branch: string | null;
	startHeadSha: string | null;
	currentHeadSha: string | null;
	commits: SessionGitCommit[];
	workingTree: SessionGitFile[];
	ahead: number;
	behind: number;
}

const COMMIT_DELIM = "\x00";
const COMMIT_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join(COMMIT_DELIM);

export async function getSessionGitSnapshot(params: {
	cwd: string;
	startHeadSha: string | null;
	/** Millisecond timestamp of when the supervisor started this run.
	 *  Used as a last-resort fallback when `startHeadSha..HEAD` returns
	 *  no commits despite HEAD having moved (happens when Claude rebased
	 *  or switched branches so the original SHA is no longer an
	 *  ancestor). In that case we surface recent commits by time instead
	 *  of showing an empty history. */
	startedAt?: number | null;
}): Promise<SessionGitSnapshot> {
	const { cwd, startHeadSha, startedAt } = params;

	const [branchOut, currentOut] = await Promise.all([
		gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		gitOut(["rev-parse", "HEAD"], cwd),
	]);
	const branch = branchOut.trim() || null;
	const currentHeadSha = currentOut.trim() || null;

	// Commits produced since the session started. If start and current
	// are the same (no new commits yet) this returns an empty list.
	let commits: SessionGitCommit[] = [];
	const parseLog = (logOut: string): SessionGitCommit[] =>
		logOut
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

	if (startHeadSha && currentHeadSha && startHeadSha !== currentHeadSha) {
		const logOut = await gitOut(
			[
				"log",
				`${startHeadSha}..${currentHeadSha}`,
				`--format=${COMMIT_FORMAT}`,
			],
			cwd,
		);
		commits = parseLog(logOut);
	}

	// Fallback: HEAD moved but `startHeadSha..HEAD` returned nothing. This
	// happens when the original SHA is no longer an ancestor of HEAD —
	// e.g. Claude rebased, amended, or switched to a divergent branch.
	// Fall back to "all commits on HEAD since the session started" so the
	// user still sees the work that was done. Use a small buffer (1s)
	// to avoid race conditions on the boundary.
	if (
		commits.length === 0 &&
		startHeadSha &&
		currentHeadSha &&
		startHeadSha !== currentHeadSha &&
		startedAt
	) {
		const sinceIso = new Date(startedAt - 1000).toISOString();
		const logOut = await gitOut(
			[
				"log",
				currentHeadSha,
				`--since=${sinceIso}`,
				`--format=${COMMIT_FORMAT}`,
			],
			cwd,
		);
		commits = parseLog(logOut);
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
		ahead,
		behind,
	};
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
