/**
 * Shared types for git operation responses that carry non-fatal warnings and
 * partial-failure classification. Frontend maps these to the unified
 * GitOperationDialog for auto-repair notifications and sync-partial reporting.
 */

export type GitOperationWarning =
	| {
			kind: "auto-published-upstream";
			/** Branch that was auto-published when a pull/sync found no upstream. */
			branch: string;
	  }
	| {
			kind: "post-push-fetch-failed";
			/** Stderr of the failed fetch after a successful push. */
			message: string;
	  }
	| {
			kind: "push-retargeted";
			/** Remote name the push was redirected to (usually the fork host for a PR). */
			remote: string;
			/** Branch name on that remote. */
			targetBranch: string;
	  }
	| {
			kind: "post-checkout-hook-failed";
			/** Brief hook stderr. */
			message: string;
	  };

/**
 * Thrown by sync() so the frontend can distinguish which stage (pull or push)
 * failed and show a tailored dialog. Message is the underlying git stderr.
 */
export class GitSyncStageError extends Error {
	readonly stage: "pull" | "push";
	readonly cause: unknown;
	constructor(stage: "pull" | "push", cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`[sync:${stage}] ${message}`);
		this.name = "GitSyncStageError";
		this.stage = stage;
		this.cause = cause;
	}
}
