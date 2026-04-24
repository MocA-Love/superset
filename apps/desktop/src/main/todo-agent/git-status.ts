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

/**
 * Swallow-errors variant that returns "" on failure. Use when a failure
 * is semantically equivalent to "no data" (e.g. `git rev-parse HEAD` on
 * a repo with zero commits yet).
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
 * Distinguish "git ran and returned empty" from "git failed". Needed for
 * ahead/behind: `rev-list HEAD...@{u}` throws when no upstream is
 * configured, which must be surfaced as `hasUpstream: false` in the UI
 * rather than silently reported as "synced" (ahead = 0, behind = 0).
 */
async function gitOutOrNull(
	args: string[],
	cwd: string,
): Promise<string | null> {
	try {
		const { stdout } = await execGitWithShellPath(args, { cwd });
		return stdout;
	} catch {
		return null;
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
	/**
	 * Original path before rename/copy. Populated only when `code` is
	 * `R` or `C`, so the UI can render `oldPath → path` instead of the
	 * broken `old.ts -> new.ts` single string the non-`-z` porcelain
	 * output used to stuff into `path`.
	 */
	oldPath?: string | null;
}

export interface SessionGitChangedFile {
	path: string;
	/** First letter of git's name-status code: A / M / D / R / C / T */
	code: string;
	/**
	 * Original path, populated only for rename/copy entries. Lets the UI
	 * render `oldPath → path` instead of losing the rename information.
	 */
	oldPath?: string | null;
}

export interface SessionGitSnapshot {
	branch: string | null;
	/**
	 * True when HEAD is detached (not on a branch). Distinguishes a
	 * detached HEAD from "ブランチ取得中…" (git rev-parse failed) so the
	 * sidebar can show `(detached HEAD)` instead of misleadingly
	 * labelling the current state as branch "HEAD".
	 */
	detachedHead: boolean;
	startHeadSha: string | null;
	currentHeadSha: string | null;
	commits: SessionGitCommit[];
	/**
	 * True when `git log <range>` was truncated by `--max-count`. The UI
	 * surfaces this so users know additional commits exist without
	 * overwhelming the sidebar for sessions that produce 1000+ commits.
	 */
	commitsTruncated: boolean;
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
	/**
	 * True when the current branch has an upstream configured.
	 * `ahead`/`behind` are only meaningful when this is true — without
	 * it, the two fields are always zero and must not be rendered as
	 * "synced" because they are simply unmeasured.
	 */
	hasUpstream: boolean;
}

// Field separator inside the %s (subject) etc. line. Unit Separator (US,
// 0x1F) is control-class so real commit text basically never contains it,
// and it plays nicely with `-z`'s record terminator (NUL).
const COMMIT_FIELD_DELIM = "\x1f";
const COMMIT_RECORD_DELIM = "\x00";
const COMMIT_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join(COMMIT_FIELD_DELIM);

/**
 * Upper bound on commits fetched per snapshot. Protects the 3-second
 * refetch loop from choking on sessions that produce hundreds of commits
 * (e.g. long-running refactors). The UI surfaces the truncation state so
 * users know the list is capped.
 */
const SESSION_COMMITS_MAX = 500;

export async function getSessionGitSnapshot(params: {
	cwd: string;
	startHeadSha: string | null;
}): Promise<SessionGitSnapshot> {
	const { cwd, startHeadSha } = params;

	const [branchOut, currentOut] = await Promise.all([
		gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		gitOut(["rev-parse", "HEAD"], cwd),
	]);
	const branchRaw = branchOut.trim();
	// `git rev-parse --abbrev-ref HEAD` returns the literal string
	// `"HEAD"` when HEAD is detached, which is useless as a branch label
	// and actively misleading in the sidebar. Collapse it to null and
	// surface the detached state via a dedicated flag.
	const detachedHead = branchRaw === "HEAD";
	const branch = !branchRaw || detachedHead ? null : branchRaw;
	const currentHeadSha = currentOut.trim() || null;

	// Commits produced since the session started. Scoped to the range
	// `startHeadSha..HEAD`; when HEAD is not a descendant of
	// startHeadSha (branch switch / reset / rebase), this can validly
	// return an empty list, and we surface cumulative file-level
	// changes via `sessionFiles` below so the sidebar isn't empty.
	let commits: SessionGitCommit[] = [];
	let commitsTruncated = false;
	let sessionFiles: SessionGitChangedFile[] = [];
	let startHeadUnreachable = false;
	if (startHeadSha && currentHeadSha && startHeadSha !== currentHeadSha) {
		const reachable = await gitRevExists(startHeadSha, cwd);
		if (!reachable) {
			startHeadUnreachable = true;
		} else {
			// `-z` terminates each commit record with NUL and keeps
			// multi-line values intact, so we no longer depend on
			// commit subjects being newline-free. The fixed number of
			// fields is separated by `\x1f` inside a single record.
			// `--max-count` caps the response for runaway sessions.
			const logOut = await gitOut(
				[
					"log",
					"-z",
					`--max-count=${SESSION_COMMITS_MAX + 1}`,
					`${startHeadSha}..${currentHeadSha}`,
					`--format=${COMMIT_FORMAT}`,
				],
				cwd,
			);
			const records = logOut
				.split(COMMIT_RECORD_DELIM)
				.filter((r) => r.length > 0);
			commits = records.slice(0, SESSION_COMMITS_MAX).map((rec) => {
				const [sha, shortSha, subject, authorName, authorDate] =
					rec.split(COMMIT_FIELD_DELIM);
				return {
					sha: sha ?? "",
					shortSha: shortSha ?? "",
					subject: subject ?? "",
					authorName: authorName ?? "",
					authorDate: authorDate ?? "",
				};
			});
			commitsTruncated = records.length > SESSION_COMMITS_MAX;

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

	// Working tree state via `--porcelain=v1 -z`. The `-z` flag is
	// *required* here — without it, rename entries come out as
	// `"old.ts -> new.ts"` stuffed into a single line, which then ends
	// up as `file.path` and breaks the downstream `git diff --cached --
	// <path>` call (there is no literal file named `"old.ts -> new.ts"`
	// in git's index). Paths containing spaces or non-ASCII characters
	// also get C-quoted without `-z`, which the split-by-newline parser
	// can't undo. Using `-z` preserves both correctness and the ability
	// to diff the file the user clicks on.
	const statusOut = await gitOut(
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		cwd,
	);
	const workingTree: SessionGitFile[] = parsePorcelainV1Nul(statusOut);

	// Ahead/behind relative to upstream, if configured. Failure is
	// expected when no upstream is set, so we distinguish it from
	// "synced" by returning null from `gitOutOrNull` and propagating
	// that through `hasUpstream`.
	let ahead = 0;
	let behind = 0;
	let hasUpstream = false;
	const rlOut = await gitOutOrNull(
		["rev-list", "--left-right", "--count", "HEAD...@{u}"],
		cwd,
	);
	if (rlOut !== null) {
		const trimmed = rlOut.trim();
		if (trimmed) {
			const parts = trimmed.split(/\s+/);
			if (parts.length === 2) {
				ahead = Number(parts[0]) || 0;
				behind = Number(parts[1]) || 0;
				hasUpstream = true;
			}
		}
	}

	return {
		branch,
		detachedHead,
		startHeadSha,
		currentHeadSha,
		commits,
		commitsTruncated,
		workingTree,
		sessionFiles,
		startHeadUnreachable,
		ahead,
		behind,
		hasUpstream,
	};
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Standard entries are `<CODE>\0<path>\0`; rename/copy entries are
 * `<CODE><score>\0<oldPath>\0<newPath>\0` — we keep the new path as
 * `path` and retain the old path as `oldPath` so the UI can render
 * `oldPath → path` instead of losing the rename information.
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
			const oldPath = parts[i + 1] ?? null;
			const newPath = parts[i + 2];
			if (newPath) {
				files.push({
					path: newPath,
					code: letter,
					oldPath: oldPath || null,
				});
			}
			i += 3;
			continue;
		}
		const p = parts[i + 1];
		if (p) files.push({ path: p, code: letter || token });
		i += 2;
	}
	return files;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 *
 * Each entry is `XY<space>path\0`. Rename/copy entries additionally
 * carry the *old* path as the next NUL-terminated token (i.e.
 * `R<space><space>newpath\0oldpath\0`). Collapsing that into a single
 * `SessionGitFile` keeps the downstream `git diff --cached -- <path>`
 * lookup working (it needs the *new* path, not `old -> new`).
 */
function parsePorcelainV1Nul(raw: string): SessionGitFile[] {
	const out: SessionGitFile[] = [];
	const seen = new Set<string>();
	const entries = raw.split("\0");
	let i = 0;
	// Trailing NUL produces an empty final segment; the loop guards on
	// `entry.length < 3` so no special-case is required.
	while (i < entries.length) {
		const entry = entries[i];
		if (!entry || entry.length < 3) {
			i += 1;
			continue;
		}
		const indexStatus = entry[0] ?? " ";
		const wtStatus = entry[1] ?? " ";
		const filePath = entry.slice(3);
		const isRenameOrCopy =
			indexStatus === "R" ||
			indexStatus === "C" ||
			wtStatus === "R" ||
			wtStatus === "C";
		let oldPath: string | null = null;
		if (isRenameOrCopy) {
			const oldPathToken = entries[i + 1];
			oldPath = oldPathToken && oldPathToken.length > 0 ? oldPathToken : null;
			// Consume both the header entry and the trailing old-path token so
			// the outer loop doesn't re-parse the old path as a standalone
			// entry (which would emit a bogus duplicate file row).
			i += 2;
		} else {
			i += 1;
		}

		const key = `${filePath}|${indexStatus}${wtStatus}`;
		if (seen.has(key)) continue;
		seen.add(key);

		if (indexStatus === "?" && wtStatus === "?") {
			out.push({ path: filePath, stage: "untracked", code: "?" });
			continue;
		}
		if (indexStatus !== " " && indexStatus !== "?") {
			out.push({
				path: filePath,
				stage: "staged",
				code: indexStatus,
				oldPath: indexStatus === "R" || indexStatus === "C" ? oldPath : null,
			});
		}
		if (wtStatus !== " " && wtStatus !== "?") {
			out.push({
				path: filePath,
				stage: "unstaged",
				code: wtStatus,
				oldPath: wtStatus === "R" || wtStatus === "C" ? oldPath : null,
			});
		}
	}
	return out;
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
