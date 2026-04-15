import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { todoPromptPresets } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { publicProcedure, router } from "lib/trpc";
import { localDb } from "main/lib/local-db";
import { workspaceInitManager } from "main/lib/workspace-init-manager";
import { z } from "zod";
import { describeEnhanceFailure, enhanceTodoText } from "./enhance-text";
import {
	getSessionFileDiff,
	getSessionGitSnapshot,
	type SessionDiffScope,
} from "./git-status";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { getTodoSupervisor } from "./supervisor";
import {
	TODO_ARTIFACT_SUBDIR,
	type TodoSessionStateEvent,
	type TodoStreamUpdate,
	todoCreateInputSchema,
	todoEnhanceTextInputSchema,
	todoPresetCreateInputSchema,
	todoPresetUpdateInputSchema,
	todoSendInputSchema,
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
				// When the UI creates a fresh workspace+worktree immediately
				// before creating the TODO (the "新しい worktree を作成して実行"
				// checkbox), `workspaces.create` returns while `git worktree
				// add` is still running in the background. Materializing the
				// artifact directory now would mkdir inside the future
				// worktree path, leaving it non-empty and causing the
				// subsequent `git worktree add` to fail — the symptom users
				// see as the sidebar error + "ブランチ取得中…" that never
				// resolves. Block until init is done (or already no-op) so
				// prepareArtifacts runs against a real worktree.
				await workspaceInitManager.waitForInit(input.workspaceId);
				if (workspaceInitManager.hasFailed(input.workspaceId)) {
					throw new Error(
						`todo-agent: workspace ${input.workspaceId} の初期化に失敗しました`,
					);
				}

				const store = getTodoSessionStore();
				const worktreePath = resolveWorktreePath(input.workspaceId);
				if (!worktreePath) {
					throw new Error(
						`todo-agent: workspace ${input.workspaceId} のパスを解決できませんでした`,
					);
				}

				// Compute the final artifact path up-front so the row is
				// inserted with its permanent path in one shot. No more
				// half-written PENDING rows left behind if the process
				// crashes between insert and update.
				const sessionId = randomUUID();
				const supervisor = getTodoSupervisor();
				const artifactPath = supervisor.computeArtifactPath({
					sessionId,
					workspaceId: input.workspaceId,
				});

				const session = store.insert({
					id: sessionId,
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
					claudeSessionId: null,
					finalAssistantText: null,
					totalCostUsd: null,
					totalNumTurns: null,
					pendingIntervention: null,
					startHeadSha: null,
					customSystemPrompt: input.customSystemPrompt ?? null,
					verdictPassed: null,
					verdictReason: null,
					verdictFailingTest: null,
					artifactPath,
					startedAt: null,
					completedAt: null,
				});

				// Materialize the directory + goal.md. If this throws after
				// the row exists the user can delete the broken session
				// from the Manager — same as any other filesystem error.
				supervisor.prepareArtifacts(session);

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

		/**
		 * Kick off the headless claude loop for a queued session. There
		 * is no pane to attach anymore — the supervisor spawns claude as
		 * a plain child process in the main process and the Manager
		 * renders the parsed stream events inline.
		 */
		start: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(async ({ input }) => {
				const store = getTodoSessionStore();
				const session = store.get(input.sessionId);
				if (!session) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "セッションが見つかりません",
					});
				}
				if (
					session.status !== "queued" &&
					session.status !== "failed" &&
					session.status !== "aborted" &&
					session.status !== "escalated"
				) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `このセッションは既に ${session.status} 状態なので開始できません`,
					});
				}
				store.update(input.sessionId, {
					status: "preparing",
					phase: "preparing",
				});
				// Fire-and-forget: the supervisor drives the rest of the loop.
				void getTodoSupervisor().start(input.sessionId);
				return { ok: true };
			}),

		abort: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(({ input }) => {
				getTodoSupervisor().abort(input.sessionId);
				return { ok: true };
			}),

		updateTitle: publicProcedure
			.input(
				z.object({
					sessionId: z.string().min(1),
					title: z.string().trim().min(1).max(200),
				}),
			)
			.mutation(({ input }) => {
				const store = getTodoSessionStore();
				const session = store.get(input.sessionId);
				if (!session) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "セッションが見つかりません",
					});
				}
				store.update(input.sessionId, { title: input.title });
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
					console.warn("[todo-agent] artifact cleanup failed", error);
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
				const nextId = randomUUID();
				const supervisor = getTodoSupervisor();
				const artifactPath = supervisor.computeArtifactPath({
					sessionId: nextId,
					workspaceId: source.workspaceId,
				});

				const next = store.insert({
					id: nextId,
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
					claudeSessionId: null,
					finalAssistantText: null,
					totalCostUsd: null,
					totalNumTurns: null,
					pendingIntervention: null,
					startHeadSha: null,
					customSystemPrompt: source.customSystemPrompt,
					verdictPassed: null,
					verdictReason: null,
					verdictFailingTest: null,
					artifactPath,
					startedAt: null,
					completedAt: null,
				});

				supervisor.prepareArtifacts(next);

				return { sessionId: next.id };
			}),

		/**
		 * Queue a user intervention for the next turn. Headless mode
		 * cannot inject text mid-stream, so interventions land at the
		 * next iteration boundary.
		 */
		sendInput: publicProcedure
			.input(todoSendInputSchema)
			.mutation(({ input }) => {
				getTodoSupervisor().queueIntervention(input.sessionId, input.data);
				return { ok: true };
			}),

		/**
		 * Snapshot of the in-memory stream events buffer for a session.
		 * Used by the Manager to paint the initial state of the detail
		 * pane before the subscription takes over.
		 */
		getStream: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.query(({ input }) =>
				getTodoSessionStore().getStreamEvents(input.sessionId),
			),

		/**
		 * Live stream events (assistant text, tool calls, verify results,
		 * errors) for the selected session. Emits the in-memory tail on
		 * subscribe then fans out every subsequent append.
		 */
		/**
		 * Per-session git snapshot: branch, current vs session-start HEAD,
		 * commits produced since the session started, working-tree files.
		 * The right-sidebar in the Manager polls this every few seconds
		 * while the session is live.
		 */
		gitSnapshot: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.query(async ({ input }) => {
				const session = getTodoSessionStore().get(input.sessionId);
				if (!session) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "セッションが見つかりません",
					});
				}
				const worktreePath = resolveWorktreePath(session.workspaceId);
				if (!worktreePath) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "ワークスペースのパスを解決できませんでした",
					});
				}
				return getSessionGitSnapshot({
					cwd: worktreePath,
					startHeadSha: session.startHeadSha ?? null,
				});
			}),

		/**
		 * Unified diff for a single file at a user-selected scope
		 * (session-range / staged / unstaged / a specific commit).
		 */
		gitFileDiff: publicProcedure
			.input(
				z.object({
					sessionId: z.string().min(1),
					path: z.string().min(1),
					scope: z.enum(["session", "staged", "unstaged", "commit"]),
					commitSha: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				const session = getTodoSessionStore().get(input.sessionId);
				if (!session) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "セッションが見つかりません",
					});
				}
				const worktreePath = resolveWorktreePath(session.workspaceId);
				if (!worktreePath) return "";
				const diff = await getSessionFileDiff({
					cwd: worktreePath,
					startHeadSha: session.startHeadSha ?? null,
					path: input.path,
					scope: input.scope as SessionDiffScope,
					commitSha: input.commitSha,
				});
				return diff;
			}),

		subscribeStream: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.subscription(({ input }) => {
				return observable<TodoStreamUpdate>((emit) => {
					const store = getTodoSessionStore();
					const initial = store.getStreamEvents(input.sessionId);
					if (initial.length > 0) {
						emit.next({
							sessionId: input.sessionId,
							events: initial,
						});
					}
					const unsubscribe = store.subscribeStream(input.sessionId, (update) =>
						emit.next(update),
					);
					return () => unsubscribe();
				});
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

		/**
		 * CRUD for reusable system-prompt templates the user attaches
		 * to new TODO sessions. Managed from the Agent Manager's
		 * Settings panel.
		 */
		presets: router({
			list: publicProcedure.query(() =>
				localDb
					.select()
					.from(todoPromptPresets)
					.orderBy(desc(todoPromptPresets.updatedAt))
					.all(),
			),
			create: publicProcedure
				.input(todoPresetCreateInputSchema)
				.mutation(({ input }) => {
					const now = Date.now();
					const row = localDb
						.insert(todoPromptPresets)
						.values({
							name: input.name,
							content: input.content,
							createdAt: now,
							updatedAt: now,
						})
						.returning()
						.get();
					return row;
				}),
			update: publicProcedure
				.input(todoPresetUpdateInputSchema)
				.mutation(({ input }) => {
					const row = localDb
						.update(todoPromptPresets)
						.set({
							name: input.name,
							content: input.content,
							updatedAt: Date.now(),
						})
						.where(eq(todoPromptPresets.id, input.id))
						.returning()
						.get();
					if (!row) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "プリセットが見つかりません",
						});
					}
					return row;
				}),
			delete: publicProcedure
				.input(z.object({ id: z.string().min(1) }))
				.mutation(({ input }) => {
					const result = localDb
						.delete(todoPromptPresets)
						.where(eq(todoPromptPresets.id, input.id))
						.run();
					return { ok: result.changes > 0 };
				}),
		}),
	});
};

export type TodoAgentRouter = ReturnType<typeof createTodoAgentRouter>;
