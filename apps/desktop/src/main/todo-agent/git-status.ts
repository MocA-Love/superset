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
}): Promise<SessionGitSnapshot> {
	const { cwd, startHeadSha } = params;

	const [branchOut, currentOut] = await Promise.all([
		gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		gitOut(["rev-parse", "HEAD"], cwd),
	]);
	const branch = branchOut.trim() || null;
	const currentHeadSha = currentOut.trim() || null;

	// Commits produced since the session started. If start and current
	// are the same (no new commits yet) this returns an empty list.
	let commits: SessionGitCommit[] = [];
	if (startHeadSha && currentHeadSha && startHeadSha !== currentHeadSha) {
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
		case "commit":
			if (!commitSha) return "";
			// `commit^!` is shorthand for `commit^..commit` = the changes
			// introduced by that single commit.
			args.splice(1, 0);
			return gitOut(
				[
					"--no-pager",
					"show",
					"--no-color",
					"--format=",
					commitSha,
					"--",
					path,
				],
				cwd,
			);
	}

	return gitOut(args, cwd);
}
