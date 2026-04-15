import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { publicProcedure, router } from "lib/trpc";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { getTodoSupervisor } from "./supervisor";
import {
	todoAttachPaneInputSchema,
	todoCreateInputSchema,
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
						`todo-agent: workspace ${input.workspaceId} has no worktree`,
					);
				}

				const session = store.insert({
					projectId: input.projectId ?? null,
					workspaceId: input.workspaceId,
					title: input.title,
					description: input.description,
					goal: input.goal,
					verifyCommand: input.verifyCommand,
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
