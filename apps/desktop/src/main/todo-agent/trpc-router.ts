import { rmSync } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { publicProcedure, router } from "lib/trpc";
import { describeEnhanceFailure, enhanceTodoText } from "./enhance-text";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { getTodoSupervisor } from "./supervisor";
import { TODO_ARTIFACT_SUBDIR } from "./types";
import {
	todoAttachPaneInputSchema,
	todoCreateInputSchema,
	todoEnhanceTextInputSchema,
	todoSendInputSchema,
	type TodoSessionStateEvent,
} from "./types";

/**
 * tRPC router for the fork-local TODO autonomous agent feature.
 *
 * Exposed as `todoAgent.*` on the app router.
 */
export const createTodoAgentRouter = () => {
	return router({
		create: publicProcedure
			.input(todoCreateInputSchema)
			.mutation(async ({ input }) => {
				const store = getTodoSessionStore();
				const worktreePath = resolveWorktreePath(input.workspaceId);
				if (!worktreePath) {
					throw new Error(
						`todo-agent: workspace ${input.workspaceId} のパスを解決できませんでした`,
					);
				}

				const session = store.insert({
					projectId: input.projectId ?? null,
					workspaceId: input.workspaceId,
					title: input.title,
					description: input.description,
					goal: input.goal ?? null,
					verifyCommand: input.verifyCommand ?? null,
					maxIterations: input.maxIterations,
					maxWallClockSec: input.maxWallClockSec,
					status: "queued",
					phase: "queued",
					iteration: 0,
					attachedPaneId: null,
					attachedTabId: null,
					verdictPassed: null,
					verdictReason: null,
					verdictFailingTest: null,
					artifactPath: `.superset/todo/PENDING`,
					startedAt: null,
					completedAt: null,
				});

				const artifactPath = getTodoSupervisor().prepareArtifacts(session);
				store.update(session.id, { artifactPath });

				return { sessionId: session.id };
			}),

		list: publicProcedure
			.input(z.object({ workspaceId: z.string().min(1) }))
			.query(({ input }) =>
				getTodoSessionStore().listForWorkspace(input.workspaceId),
			),

		// Cross-workspace feed used by the Agent-Manager-style view.
		listAll: publicProcedure.query(() => getTodoSessionStore().listAll()),

		enhanceText: publicProcedure
			.input(todoEnhanceTextInputSchema)
			.mutation(async ({ input }) => {
				const { text, attempts } = await enhanceTodoText(
					input.text,
					input.kind,
				);
				if (text === null) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: describeEnhanceFailure(attempts),
					});
				}
				return { text };
			}),

		get: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.query(({ input }) => getTodoSessionStore().get(input.sessionId)),

		attachPane: publicProcedure
			.input(todoAttachPaneInputSchema)
			.mutation(async ({ input }) => {
				const store = getTodoSessionStore();
				store.update(input.sessionId, {
					attachedPaneId: input.paneId,
					attachedTabId: input.tabId,
					status: "preparing",
				});
				// Fire-and-forget: kick off the loop.
				void getTodoSupervisor().attachAndStart(input.sessionId);
				return { ok: true };
			}),

		abort: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(({ input }) => {
				getTodoSupervisor().abort(input.sessionId);
				return { ok: true };
			}),

		delete: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(({ input }) => {
				const store = getTodoSessionStore();
				const session = store.get(input.sessionId);
				if (!session) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "セッションが見つかりません",
					});
				}
				// Best-effort: make sure the supervisor is not still driving
				// the session before we wipe its row. abort() is a no-op if
				// the session is not currently active.
				try {
					getTodoSupervisor().abort(input.sessionId);
				} catch (error) {
					console.warn("[todo-agent] abort-before-delete failed", error);
				}

				const removed = store.remove(input.sessionId);
				if (!removed) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "セッションの削除に失敗しました",
					});
				}

				// Best-effort artifact cleanup. Failure to remove the
				// directory should not fail the mutation — the DB row is
				// already gone and the directory is just scratch data.
				try {
					const worktreePath = resolveWorktreePath(session.workspaceId);
					if (worktreePath) {
						const dir = path.join(
							worktreePath,
							TODO_ARTIFACT_SUBDIR,
							session.id,
						);
						rmSync(dir, { recursive: true, force: true });
					}
				} catch (error) {
					console.warn(
						"[todo-agent] artifact cleanup failed",
						error,
					);
				}

				return { ok: true };
			}),

		rerun: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(({ input }) => {
				const store = getTodoSessionStore();
				const source = store.get(input.sessionId);
				if (!source) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "元セッションが見つかりません",
					});
				}

				// Create a brand-new queued session that copies the user-
				// authored fields from the source. Verdict / iteration /
				// pane attachment are reset so the new session starts
				// clean in the Agent Manager.
				const next = store.insert({
					projectId: source.projectId,
					workspaceId: source.workspaceId,
					title: source.title,
					description: source.description,
					goal: source.goal,
					verifyCommand: source.verifyCommand,
					maxIterations: source.maxIterations,
					maxWallClockSec: source.maxWallClockSec,
					status: "queued",
					phase: "queued",
					iteration: 0,
					attachedPaneId: null,
					attachedTabId: null,
					verdictPassed: null,
					verdictReason: null,
					verdictFailingTest: null,
					artifactPath: `.superset/todo/PENDING`,
					startedAt: null,
					completedAt: null,
				});

				const artifactPath = getTodoSupervisor().prepareArtifacts(next);
				store.update(next.id, { artifactPath });

				return { sessionId: next.id };
			}),

		sendInput: publicProcedure
			.input(todoSendInputSchema)
			.mutation(({ input }) => {
				getTodoSupervisor().sendInput(input.sessionId, input.data);
				return { ok: true };
			}),

		subscribeState: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.subscription(({ input }) => {
				return observable<TodoSessionStateEvent>((emit) => {
					const store = getTodoSessionStore();
					// Emit current state immediately on subscribe.
					const current = store.get(input.sessionId);
					if (current) {
						emit.next({ sessionId: current.id, session: current });
					}
					const unsubscribe = store.subscribe(input.sessionId, (event) => {
						emit.next(event);
					});
					return () => unsubscribe();
				});
			}),
	});
};

export type TodoAgentRouter = ReturnType<typeof createTodoAgentRouter>;
