/**
 * Classifier for git stderr/error messages used by the unified GitOperationDialog.
 *
 * Given an Error or string + the operation context, return a kind enum plus
 * extracted data for the dialog to render. Pure function — no side effects.
 *
 * Patterns are derived from:
 *  - apps/desktop/src/lib/trpc/routers/changes/utils/git-push.ts (isNonFastForwardPushError, etc.)
 *  - apps/desktop/src/lib/trpc/routers/changes/git-utils.ts (isUpstreamMissingError)
 *  - empirical git CLI stderr wording
 */

export type GitOperationContext =
	| "commit"
	| "push"
	| "pull"
	| "sync"
	| "fetch"
	| "stash"
	| "stash-pop"
	| "merge-pr"
	| "create-pr"
	| "switch-branch"
	| "create-branch"
	| "stage"
	| "unstage"
	| "discard"
	| "generic";

export type GitErrorKind =
	// push
	| "push-rejected"
	| "push-protected-branch"
	| "push-no-remote-for-pr"
	// pull / merge
	| "pull-conflict"
	| "pull-overwrite"
	| "pull-upstream-missing"
	// commit
	| "commit-hook-failed"
	| "commit-gpg-failed"
	| "commit-identity-missing"
	| "nothing-to-commit"
	// auth / network / remote
	| "auth-failed"
	| "network-error"
	| "no-remote"
	// stash
	| "stash-pop-conflict"
	| "nothing-to-stash"
	// git state
	| "index-lock"
	| "detached-head"
	// discard / fs
	| "permission-denied"
	// PR
	| "pr-not-mergeable"
	| "pr-already-done"
	| "pr-not-found"
	// branch
	| "branch-name-collision"
	| "branch-behind-upstream"
	// non-git
	| "non-git-repo"
	// generic fallback
	| "generic-error";

export interface ClassifiedGitError {
	kind: GitErrorKind;
	rawMessage: string;
	context: GitOperationContext;
	data: {
		/** File list when conflict/overwrite patterns mention specific paths. */
		conflictFiles?: string[];
		overwriteFiles?: string[];
		/** Remote name if auto-detected from message. */
		remote?: string;
		/** Branch name if extracted. */
		branch?: string;
		/** Suggested new branch name when a collision is detected. */
		suggestedBranchName?: string;
		/** Hook name for hook failures (pre-commit, commit-msg, etc.). */
		hookName?: string;
	};
}

function normalizeMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function _includes(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

function _includesAny(haystack: string, needles: string[]): boolean {
	const lower = haystack.toLowerCase();
	return needles.some((n) => lower.includes(n.toLowerCase()));
}

function extractConflictFiles(message: string): string[] {
	const files = new Set<string>();
	const patterns = [
		/CONFLICT[^:]*:\s*(?:Merge conflict in\s+|content\):\s*Merge conflict in\s+)?([^\n]+)/gi,
		/both modified:\s+([^\n]+)/gi,
		/both added:\s+([^\n]+)/gi,
		/both deleted:\s+([^\n]+)/gi,
		/Auto-merging\s+([^\n]+)\nCONFLICT/gi,
	];
	for (const re of patterns) {
		let match = re.exec(message);
		while (match) {
			// Keep filenames with spaces — git emits them literally in merge
			// conflict messages (see `CONFLICT (content): Merge conflict in file
			// with spaces.ts`). The previous `!file.includes(" ")` guard was
			// inconsistent with extractOverwriteFiles and silently dropped valid
			// paths.
			const file = match[1]?.trim();
			if (file) {
				files.add(file);
			}
			match = re.exec(message);
		}
	}
	return Array.from(files);
}

function extractOverwriteFiles(message: string): string[] {
	const files = new Set<string>();
	// "error: Your local changes to the following files would be overwritten by merge:\n\tfile1\n\tfile2"
	const blockMatch = message.match(
		/local changes to the following files would be overwritten[^\n]*\n([\s\S]*?)(?:\n[A-Z]|$)/i,
	);
	if (blockMatch?.[1]) {
		for (const line of blockMatch[1].split("\n")) {
			const trimmed = line.replace(/^\s+/, "").trim();
			if (trimmed && !trimmed.toLowerCase().startsWith("please")) {
				files.add(trimmed);
			}
		}
	}
	return Array.from(files);
}

function extractHookName(message: string): string | undefined {
	const match = message.match(
		/(pre-commit|commit-msg|prepare-commit-msg|pre-push|post-checkout|pre-rebase)/i,
	);
	return match?.[1]?.toLowerCase();
}

function classifyPushError(
	message: string,
	context: GitOperationContext,
): GitErrorKind | null {
	const lower = message.toLowerCase();

	// Protected branch (GitHub returns this through push stderr)
	if (
		lower.includes("protected branch") ||
		lower.includes("gh006") ||
		lower.includes("(protected branch hook declined)")
	) {
		return "push-protected-branch";
	}

	// Non-fast-forward / rejected
	if (
		lower.includes("non-fast-forward") ||
		(lower.includes("failed to push some refs") &&
			(lower.includes("rejected") ||
				lower.includes("fetch first") ||
				lower.includes("tip of your current branch is behind") ||
				lower.includes("remote contains work")))
	) {
		return "push-rejected";
	}

	// No remote for existing PR (from our backend TRPCError wording)
	if (
		lower.includes("couldn't find a git remote") ||
		lower.includes("couldn't find a remote for")
	) {
		return "push-no-remote-for-pr";
	}

	return context === "push" || context === "sync" ? null : null;
}

function classifyPullError(message: string): GitErrorKind | null {
	const lower = message.toLowerCase();

	if (
		lower.includes("conflict") ||
		lower.includes("unmerged") ||
		lower.includes("fix conflicts and then commit")
	) {
		return "pull-conflict";
	}

	if (
		lower.includes(
			"local changes to the following files would be overwritten",
		) ||
		lower.includes("would be overwritten by merge") ||
		lower.includes("would be overwritten by checkout") ||
		lower.includes("please commit your changes or stash")
	) {
		return "pull-overwrite";
	}

	if (
		lower.includes("no tracking information") ||
		lower.includes("no such ref was fetched") ||
		lower.includes("couldn't find remote ref") ||
		lower.includes("no upstream configured") ||
		lower.includes("no upstream branch")
	) {
		return "pull-upstream-missing";
	}

	return null;
}

function classifyCommitError(message: string): GitErrorKind | null {
	const lower = message.toLowerCase();

	if (
		lower.includes("please tell me who you are") ||
		lower.includes("user.email") ||
		lower.includes("empty ident name")
	) {
		return "commit-identity-missing";
	}

	if (
		lower.includes("gpg failed to sign") ||
		lower.includes("gpg: signing failed") ||
		lower.includes("secret key not available") ||
		lower.includes("no secret key")
	) {
		return "commit-gpg-failed";
	}

	if (
		lower.includes("nothing to commit") ||
		lower.includes("no changes added to commit")
	) {
		return "nothing-to-commit";
	}

	// Hook failure — check last because hook stderr can contain arbitrary text.
	if (
		lower.includes("pre-commit") ||
		lower.includes("commit-msg hook") ||
		lower.includes("hook failed") ||
		lower.includes("husky") ||
		lower.match(/hook[^a-z]+(declined|failed|exited|returned)/)
	) {
		return "commit-hook-failed";
	}

	return null;
}

function classifyAuthOrNetwork(message: string): GitErrorKind | null {
	const lower = message.toLowerCase();

	if (
		lower.includes("authentication failed") ||
		lower.includes("could not read username") ||
		lower.includes("permission denied (publickey)") ||
		lower.includes("invalid credentials") ||
		lower.includes("bad credentials") ||
		lower.includes("requires authentication") ||
		lower.includes("http 401") ||
		lower.includes("http 403") ||
		lower.includes("http basic: access denied") ||
		(lower.includes("token ") && lower.includes("expired"))
	) {
		return "auth-failed";
	}

	if (
		lower.includes("could not resolve host") ||
		lower.includes("connection timed out") ||
		lower.includes("connection refused") ||
		lower.includes("failed to connect") ||
		lower.includes("network is unreachable") ||
		lower.includes("network error") ||
		lower.includes("unable to access") ||
		lower.includes("operation timed out")
	) {
		return "network-error";
	}

	return null;
}

function classifyStashError(
	message: string,
	context: GitOperationContext,
): GitErrorKind | null {
	const lower = message.toLowerCase();

	if (
		lower.includes("no stash entries") ||
		lower.includes("no local changes to save")
	) {
		return context === "stash" ? "nothing-to-stash" : null;
	}

	if (
		context === "stash-pop" &&
		(lower.includes("conflict") ||
			lower.includes("could not apply") ||
			lower.includes("needs merge"))
	) {
		return "stash-pop-conflict";
	}

	return null;
}

function classifyMergePRError(message: string): GitErrorKind | null {
	const lower = message.toLowerCase();

	if (lower.includes("no pull request")) return "pr-not-found";
	if (lower.includes("already merged") || lower.includes("pr is closed")) {
		return "pr-already-done";
	}
	if (
		lower.includes("cannot be merged") ||
		lower.includes("not in mergeable") ||
		lower.includes("merge conflicts") ||
		lower.includes("required status checks") ||
		lower.includes("review is required")
	) {
		return "pr-not-mergeable";
	}
	return null;
}

/**
 * Classify a git error message into a structured kind + extracted data.
 * Caller passes the operation context; we use it to disambiguate (e.g. a
 * "conflict" message during stash-pop vs pull).
 */
export function classifyGitError(
	error: unknown,
	context: GitOperationContext,
): ClassifiedGitError {
	const rawMessage = normalizeMessage(error);
	const lower = rawMessage.toLowerCase();

	// State issues come first — they apply regardless of context.
	if (
		lower.includes("index.lock") ||
		lower.includes("unable to create '.git/index.lock'")
	) {
		return {
			kind: "index-lock",
			rawMessage,
			context,
			data: {},
		};
	}

	if (
		lower.includes("detached head") ||
		lower.includes("head detached") ||
		(lower.includes("cannot") && lower.includes("from detached head"))
	) {
		return {
			kind: "detached-head",
			rawMessage,
			context,
			data: {},
		};
	}

	if (lower.includes("not a git repository")) {
		return { kind: "non-git-repo", rawMessage, context, data: {} };
	}

	if (
		lower.includes("permission denied") &&
		!lower.includes("publickey") &&
		!lower.includes("(publickey)")
	) {
		return { kind: "permission-denied", rawMessage, context, data: {} };
	}

	if (lower.includes("branch is behind upstream")) {
		return { kind: "branch-behind-upstream", rawMessage, context, data: {} };
	}

	// Context-specific dispatching.
	let kind: GitErrorKind | null = null;

	if (context === "push" || context === "sync") {
		kind = classifyPushError(rawMessage, context);
	}
	if (!kind && (context === "pull" || context === "sync")) {
		kind = classifyPullError(rawMessage);
	}
	if (!kind && context === "commit") {
		kind = classifyCommitError(rawMessage);
	}
	if (!kind && (context === "stash" || context === "stash-pop")) {
		kind = classifyStashError(rawMessage, context);
	}
	if (!kind && context === "merge-pr") {
		kind = classifyMergePRError(rawMessage);
	}

	// Auth/network applies to any remote op and is last priority.
	if (!kind) {
		kind = classifyAuthOrNetwork(rawMessage);
	}

	// No remote configured
	if (
		!kind &&
		(lower.includes("does not appear to be a git repository") ||
			lower.includes("no such remote"))
	) {
		kind = "no-remote";
	}

	// Branch collision (create-branch)
	if (
		!kind &&
		context === "create-branch" &&
		lower.includes("already exists")
	) {
		kind = "branch-name-collision";
	}

	kind = kind ?? "generic-error";

	return {
		kind,
		rawMessage,
		context,
		data: {
			conflictFiles:
				kind === "pull-conflict" || kind === "stash-pop-conflict"
					? extractConflictFiles(rawMessage)
					: undefined,
			overwriteFiles:
				kind === "pull-overwrite"
					? extractOverwriteFiles(rawMessage)
					: undefined,
			hookName:
				kind === "commit-hook-failed" ? extractHookName(rawMessage) : undefined,
		},
	};
}
