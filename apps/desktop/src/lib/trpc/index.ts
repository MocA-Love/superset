import { createTRPCReact } from "@trpc/react-query";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { SessionDisposedError } from "../errors";
import type { AppRouter } from "./routers";
import { NotGitRepoError } from "./routers/workspaces/utils/git";
import { WorktreePathMissingError } from "./routers/workspaces/utils/git-client";

/**
 * Core tRPC initialization
 * This provides the base router and procedure builders used by all routers
 */
const t = initTRPC.create({
	transformer: superjson,
	isServer: true,
});

/**
 * Middleware that captures errors with Sentry
 */
const sentryMiddleware = t.middleware(async ({ next, path, type }) => {
	const result = await next();

	if (!result.ok) {
		// Only report unexpected server errors to Sentry.
		// Expected user-facing errors (BAD_REQUEST, NOT_FOUND, PRECONDITION_FAILED, etc.)
		// are handled by the client and don't indicate bugs.
		if (result.error.code === "INTERNAL_SERVER_ERROR") {
			const error = result.error;

			// Get the original error if it's wrapped in a TRPCError
			const originalError = error.cause instanceof Error ? error.cause : error;

			// Don't report expected user conditions to Sentry.
			// These are races/lifecycle events, not bugs — reporting them floods
			// the dashboard (ELECTRON-26/1Z hit 5000+ events in one session).
			// The `.name` check catches errors re-thrown from worker threads
			// (WorkerTaskError preserves the original name but not the class).
			const errorName =
				originalError instanceof Error ? originalError.name : null;
			if (
				originalError instanceof NotGitRepoError ||
				originalError instanceof WorktreePathMissingError ||
				originalError instanceof SessionDisposedError ||
				errorName === "NotGitRepoError" ||
				errorName === "WorktreePathMissingError" ||
				errorName === "SessionDisposedError"
			) {
				return result;
			}

			// User-environment errors bubbled out through tRPC. These tell us
			// nothing actionable about the app itself — they're about the user's
			// disk, their gh CLI auth, or the remote they were pushing to.
			const message =
				originalError instanceof Error ? originalError.message : "";
			// NOTE: これらは「ユーザー環境起因」のノイズだけを握りつぶす意図。
			// 広いパターン (例: "Operation timed out" 単独、"Command failed: gh" の
			// 全サブコマンド) を入れると、本来修正すべきアプリ側の呼び出しバグや
			// 本家リポジトリ操作の不具合まで消してしまうので、外部ネットワーク/
			// 外部プロセスに帰着できる文脈 (ssh, remote repo push, gh auth) に
			// 限定した文字列を重ねて使う。
			const USER_ENV_NOISE_PATTERNS = [
				// Disk full (ELECTRON-25)
				"ENOSPC: no space left on device",
				// gh CLI auth/network failures — auth / api / clone / pr view など
				// 外部 GitHub への通信系だけに絞る (ELECTRON-R/18)
				"Command failed: gh auth",
				"Command failed: gh api",
				"Command failed: gh repo clone",
				"Command failed: gh pr view",
				"Command failed: gh pr list",
				// Git push rejections and remote connectivity (ELECTRON-P/16/21/22)
				"the remote end hung up unexpectedly",
				"ssh_dispatch_run_fatal",
				"! [rejected]",
				"failed to push some refs",
			];
			if (
				USER_ENV_NOISE_PATTERNS.some((pattern) => message.includes(pattern))
			) {
				return result;
			}

			try {
				const Sentry = await import("@sentry/electron/main");

				Sentry.captureException(originalError, {
					tags: {
						trpc_path: path,
						trpc_type: type,
						trpc_code: error.code,
					},
					extra: {
						trpc_message: error.message,
					},
				});
			} catch {
				// Sentry not available
			}
		}
	}

	return result;
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure.use(sentryMiddleware);
export const trpc = createTRPCReact<AppRouter>();
