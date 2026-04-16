import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { todoPromptPresets } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { app } from "electron";
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
import { getTodoScheduleStore } from "./schedule-store";
import { computeNextRunAt, getTodoScheduler } from "./scheduler";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { getTodoSettings, updateTodoSettings } from "./settings";
import { getTodoSupervisor } from "./supervisor";
import {
	TODO_ARTIFACT_SUBDIR,
	type TodoScheduleFireEvent,
	type TodoSessionStateEvent,
	type TodoStreamUpdate,
	todoCreateInputSchema,
	todoEnhanceTextInputSchema,
	todoPresetCreateInputSchema,
	todoPresetUpdateInputSchema,
	todoScheduleCreateInputSchema,
	todoScheduleUpdateInputSchema,
	todoSendInputSchema,
	todoSettingsUpdateSchema,
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
				//
				// `waitForInit` has a 30s internal timeout that resolves
				// silently even if init is still running, so a slow
				// fetch/clone path could still slip through. Loop on the
				// `isInitializing` flag so we really block until the job
				// reaches a terminal state, up to a generous ceiling.
				const INIT_WAIT_STEP_MS = 30_000;
				const INIT_WAIT_CEILING_MS = 10 * 60_000;
				const waitStartedAt = Date.now();
				while (workspaceInitManager.isInitializing(input.workspaceId)) {
					if (Date.now() - waitStartedAt > INIT_WAIT_CEILING_MS) {
						throw new TRPCError({
							code: "TIMEOUT",
							message: `todo-agent: workspace ${input.workspaceId} の初期化が時間内に終わりませんでした`,
						});
					}
					await workspaceInitManager.waitForInit(
						input.workspaceId,
						INIT_WAIT_STEP_MS,
					);
				}
				if (workspaceInitManager.hasFailed(input.workspaceId)) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `todo-agent: workspace ${input.workspaceId} の初期化に失敗しました`,
					});
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

				const session = store.insertQueuedFromTemplate({
					id: sessionId,
					projectId: input.projectId ?? null,
					workspaceId: input.workspaceId,
					title: input.title,
					description: input.description,
					goal: input.goal,
					verifyCommand: input.verifyCommand,
					maxIterations: input.maxIterations,
					maxWallClockSec: input.maxWallClockSec,
					customSystemPrompt: input.customSystemPrompt,
					artifactPath,
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

		/**
		 * Edit the user-authored fields (description / goal) of a TODO
		 * session. Allowed in queued / preparing / failed / aborted /
		 * escalated. `preparing` is safe because the supervisor has
		 * not spawned Claude yet and `prepareArtifacts` will rewrite
		 * goal.md before it is read. Refused once the session is
		 * running / verifying so the worker's prompt never mutates
		 * under its feet.
		 */
		updateFields: publicProcedure
			.input(
				z.object({
					sessionId: z.string().min(1),
					description: z.string().trim().min(1).max(10_000).optional(),
					goal: z
						.string()
						.trim()
						.max(10_000)
						.optional()
						.transform((v) => (v && v.length > 0 ? v : undefined)),
					clearGoal: z.boolean().optional(),
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
				if (
					session.status !== "queued" &&
					session.status !== "preparing" &&
					session.status !== "failed" &&
					session.status !== "aborted" &&
					session.status !== "escalated"
				) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"実行中のセッションは編集できません。中断してから再度お試しください。",
					});
				}
				const patch: {
					description?: string;
					goal?: string | null;
				} = {};
				if (input.description !== undefined) {
					patch.description = input.description;
				}
				if (input.clearGoal) {
					patch.goal = null;
				} else if (input.goal !== undefined) {
					patch.goal = input.goal;
				}
				const updated = store.update(input.sessionId, patch);
				// Rewrite goal.md so a subsequent Start reads the edited
				// content from disk (the iteration prompt tells Claude to
				// read that file first, so stale on-disk content would
				// silently shadow the edit).
				if (updated) {
					try {
						getTodoSupervisor().prepareArtifacts(updated);
					} catch (error) {
						console.warn("[todo-agent] goal.md rewrite failed", error);
					}
				}
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
							kind: input.kind,
							workspaceId: input.workspaceId ?? null,
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
					const patch: {
						name: string;
						content: string;
						updatedAt: number;
						kind?: "system" | "description" | "goal";
						workspaceId?: string | null;
					} = {
						name: input.name,
						content: input.content,
						updatedAt: Date.now(),
					};
					if (input.kind !== undefined) patch.kind = input.kind;
					if (input.workspaceId !== undefined)
						patch.workspaceId = input.workspaceId;
					const row = localDb
						.update(todoPromptPresets)
						.set(patch)
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

		/**
		 * Save a pasted/dropped image (or any binary) to disk and return
		 * its absolute path. Used by the composer/intervention textareas
		 * to let the user embed screenshots via paste or drag-and-drop.
		 * The returned path can be referenced from the Claude prompt as
		 * a markdown image (`![](path)`) — Claude's Read tool opens it.
		 */
		saveAttachment: publicProcedure
			.input(
				z.object({
					fileName: z.string().min(1).max(200),
					mimeType: z.string().min(1).max(120),
					// Hard cap ~15MB raw binary (= ~20MB base64 chars).
					// Client-side paste handler enforces a 10MB ceiling;
					// this larger server bound absorbs rounding + encoding
					// overhead while still blocking absurd paste payloads
					// before they hit the tRPC channel.
					dataBase64: z
						.string()
						.min(1)
						.max(20 * 1024 * 1024),
				}),
			)
			.mutation(({ input }) => {
				const dir = path.join(
					app.getPath("userData"),
					"todo-agent",
					"attachments",
				);
				mkdirSync(dir, { recursive: true });
				const extFromName = path.extname(input.fileName).toLowerCase();
				const extFromMime =
					input.mimeType === "image/png"
						? ".png"
						: input.mimeType === "image/jpeg" || input.mimeType === "image/jpg"
							? ".jpg"
							: input.mimeType === "image/gif"
								? ".gif"
								: input.mimeType === "image/webp"
									? ".webp"
									: "";
				const ext = extFromName || extFromMime || ".bin";
				const safeName = input.fileName.replace(/[^\w.-]/g, "_").slice(0, 80);
				const filename = `${randomUUID()}-${safeName}${
					safeName.toLowerCase().endsWith(ext) ? "" : ext
				}`;
				const filePath = path.join(dir, filename);
				const buf = Buffer.from(input.dataBase64, "base64");
				writeFileSync(filePath, buf);
				return { path: filePath };
			}),

		settings: router({
			get: publicProcedure.query(() => getTodoSettings()),
			update: publicProcedure
				.input(todoSettingsUpdateSchema)
				.mutation(({ input }) => updateTodoSettings(input)),
		}),

		schedule: router({
			list: publicProcedure
				.input(z.object({ projectId: z.string().min(1) }))
				.query(({ input }) =>
					getTodoScheduleStore().listForProject(input.projectId),
				),
			listAll: publicProcedure.query(() => getTodoScheduleStore().listAll()),
			create: publicProcedure
				.input(todoScheduleCreateInputSchema)
				.mutation(({ input }) => {
					const nextRunAt = input.enabled
						? computeNextRunAt(
								{
									frequency: input.frequency,
									minute: input.minute ?? null,
									hour: input.hour ?? null,
									weekday: input.weekday ?? null,
									monthday: input.monthday ?? null,
									cronExpr: input.cronExpr ?? null,
								},
								new Date(),
							)
						: null;
					const row = getTodoScheduleStore().insert({
						...input,
						nextRunAt,
					});
					return row;
				}),
			update: publicProcedure
				.input(todoScheduleUpdateInputSchema)
				.mutation(({ input }) => {
					const row = getTodoScheduleStore().update(input);
					if (row) {
						getTodoScheduler().refreshNextRunAt(row.id);
					}
					return row ?? null;
				}),
			setEnabled: publicProcedure
				.input(
					z.object({
						id: z.string().min(1),
						enabled: z.boolean(),
					}),
				)
				.mutation(({ input }) => {
					const row = getTodoScheduleStore().setEnabled(
						input.id,
						input.enabled,
					);
					if (row) {
						getTodoScheduler().refreshNextRunAt(row.id);
					}
					return row ?? null;
				}),
			delete: publicProcedure
				.input(z.object({ id: z.string().min(1) }))
				.mutation(({ input }) => {
					const ok = getTodoScheduleStore().delete(input.id);
					return { ok };
				}),
			previewNextRun: publicProcedure
				.input(
					z.object({
						frequency: z.enum([
							"hourly",
							"daily",
							"weekly",
							"monthly",
							"custom",
						]),
						minute: z.number().int().min(0).max(59).nullish(),
						hour: z.number().int().min(0).max(23).nullish(),
						weekday: z.number().int().min(0).max(6).nullish(),
						monthday: z.number().int().min(1).max(31).nullish(),
						cronExpr: z.string().trim().max(200).nullish(),
					}),
				)
				.query(({ input }) =>
					computeNextRunAt(
						{
							frequency: input.frequency,
							minute: input.minute ?? null,
							hour: input.hour ?? null,
							weekday: input.weekday ?? null,
							monthday: input.monthday ?? null,
							cronExpr: input.cronExpr ?? null,
						},
						new Date(),
					),
				),
			onFire: publicProcedure.subscription(() =>
				observable<TodoScheduleFireEvent>((emit) => {
					const off = getTodoScheduleStore().onFire((event) => {
						emit.next(event);
					});
					return () => {
						off();
					};
				}),
			),
		}),
	});
};

export type TodoAgentRouter = ReturnType<typeof createTodoAgentRouter>;
