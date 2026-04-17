import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import {
	projects,
	type SelectTodoSession,
	todoSessions,
	workspaces,
	worktrees,
} from "@superset/local-db";
import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lte,
	not,
	notInArray,
} from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import type {
	TodoSessionListEntry,
	TodoSessionStateEvent,
	TodoStreamEvent,
	TodoStreamUpdate,
} from "./types";

export type { TodoSessionListEntry };

const STREAM_JSONL_FILE = "stream.jsonl";

/**
 * Cap on the number of stream events we keep in memory per session. Enough
 * to show "the whole current run" in the UI without letting an unbounded
 * stream balloon process memory. Older events are dropped from the head.
 */
const STREAM_EVENT_BUFFER_CAP = 500;

/**
 * In-memory session bookkeeping + persistence helpers for the TODO agent.
 *
 * All state transitions go through `updateSession` so we have exactly one
 * place that writes to the DB and emits the state event consumed by the
 * tRPC subscription.
 */
class TodoSessionStore {
	private readonly emitter = new EventEmitter();
	/** In-memory per-session stream event buffer. Not persisted. */
	private readonly streamBuffers = new Map<string, TodoStreamEvent[]>();
	/**
	 * Cached absolute artifact path per sessionId. The supervisor
	 * primes this at the start of each run via `setArtifactPathCache`
	 * so append-hot stream writes do not need to hit SQLite on every
	 * event.
	 */
	private readonly artifactPathCache = new Map<string, string>();
	/**
	 * Per-session serialized append chain. `appendFile` from
	 * node:fs/promises is async, and bursts of stream events can race
	 * and write out-of-order. We sequence them per session via a
	 * promise chain — cheap and avoids reordering the JSONL.
	 */
	private readonly persistQueues = new Map<string, Promise<void>>();

	constructor() {
		this.emitter.setMaxListeners(0);
		// Rehydration is now delegated to the todo-agent daemon so sessions
		// that survive the main process close aren't mistakenly marked
		// failed. The daemon calls `rehydrateStrandedSessionsExcept` with
		// the set of sessions it's actively driving.
	}

	setArtifactPathCache(sessionId: string, artifactPath: string | null): void {
		if (artifactPath?.startsWith("/")) {
			this.artifactPathCache.set(sessionId, artifactPath);
			// Make sure the directory exists once, up-front, so the async
			// appendFile calls below never race on mkdir.
			try {
				mkdirSync(artifactPath, { recursive: true });
			} catch (error) {
				console.warn("[todo-agent] artifact mkdir failed", error);
			}
		} else {
			this.artifactPathCache.delete(sessionId);
		}
	}

	appendStreamEvents(sessionId: string, events: TodoStreamEvent[]): void {
		if (events.length === 0) return;
		const buffer = this.streamBuffers.get(sessionId) ?? [];
		buffer.push(...events);
		// Drop from the head if we are over the cap so the tail (most
		// recent activity) is always preserved.
		if (buffer.length > STREAM_EVENT_BUFFER_CAP) {
			buffer.splice(0, buffer.length - STREAM_EVENT_BUFFER_CAP);
		}
		this.streamBuffers.set(sessionId, buffer);

		// Persist every event to disk so that sessions stay reviewable
		// across app restarts and after the in-memory cap evicts them.
		// The file lives inside the per-session artifact dir we already
		// created via `prepareArtifacts`, so cleanup is automatic when
		// the session (and its artifact dir) are deleted.
		this.persistStreamEvents(sessionId, events);

		const update: TodoStreamUpdate = { sessionId, events };
		this.emitter.emit(`stream:${sessionId}`, update);
	}

	getStreamEvents(sessionId: string): TodoStreamEvent[] {
		const inMemory = this.streamBuffers.get(sessionId);
		if (inMemory && inMemory.length > 0) return [...inMemory];
		// Fall back to the JSONL file — this is how we hydrate a past
		// session whose in-memory buffer was cleared (either by app
		// restart or by the eviction cap).
		return this.loadStreamEventsFromDisk(sessionId);
	}

	clearStreamEvents(sessionId: string): void {
		this.streamBuffers.delete(sessionId);
	}

	private persistStreamEvents(
		sessionId: string,
		events: TodoStreamEvent[],
	): void {
		// Fast-path: use the cached absolute path the supervisor primed
		// when the run started. Falls back to a DB read only when no
		// cache entry exists (e.g. a historical session being replayed
		// outside of a run).
		let dir = this.artifactPathCache.get(sessionId);
		if (!dir) {
			const session = this.get(sessionId);
			dir = session?.artifactPath;
			if (dir?.startsWith("/")) {
				this.artifactPathCache.set(sessionId, dir);
			}
		}
		if (!dir || !dir.startsWith("/")) return;
		const filePath = path.join(dir, STREAM_JSONL_FILE);
		const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

		// Chain async appends so bursty event streams stay ordered in
		// the JSONL file and main process is not blocked on fs I/O.
		const previous = this.persistQueues.get(sessionId) ?? Promise.resolve();
		const nextTask = previous
			.catch(() => {})
			.then(() => appendFile(filePath, body, "utf8"))
			.catch((error) => {
				console.warn("[todo-agent] stream persist failed", error);
			});
		this.persistQueues.set(sessionId, nextTask);
	}

	/**
	 * On daemon startup, any session that was mid-run when the previous
	 * daemon died will still have a non-terminal status
	 * (`preparing` / `running` / `verifying`) in the DB even though the
	 * daemon has no record of it. Flip those to `failed` so the user
	 * can re-run or delete from the UI.
	 *
	 * `activeSessionIds` is the set of sessions the daemon is **currently**
	 * driving (ActiveRun map keys). Those are skipped so a running
	 * daemon that reconnects doesn't stomp on its own live work.
	 *
	 * Safe to call multiple times; behaves as a no-op when nothing is
	 * stranded. Returns the number of rows rehydrated.
	 */
	rehydrateStrandedSessionsExcept(activeSessionIds: readonly string[]): number {
		try {
			const baseCondition = inArray(todoSessions.status, [
				"preparing",
				"running",
				"verifying",
			]);
			const whereClause =
				activeSessionIds.length > 0
					? and(
							baseCondition,
							notInArray(todoSessions.id, activeSessionIds as string[]),
						)
					: baseCondition;
			const stranded = localDb
				.update(todoSessions)
				.set({
					status: "failed",
					phase: "failed",
					verdictPassed: false,
					verdictReason:
						"前回の実行が中断されました（daemon が停止）。再実行するか削除してください。",
					completedAt: Date.now(),
					updatedAt: Date.now(),
				})
				.where(whereClause)
				.returning()
				.all();
			for (const row of stranded) {
				this.emit(row);
			}
			if (stranded.length > 0) {
				console.log(
					`[todo-agent] rehydrated ${stranded.length} stranded session(s)`,
				);
			}
			return stranded.length;
		} catch (error) {
			console.warn("[todo-agent] rehydrate on startup failed", error);
			return 0;
		}
	}

	private loadStreamEventsFromDisk(sessionId: string): TodoStreamEvent[] {
		try {
			const session = this.get(sessionId);
			const dir = session?.artifactPath;
			if (!dir || !dir.startsWith("/")) return [];
			const filePath = path.join(dir, STREAM_JSONL_FILE);
			if (!existsSync(filePath)) return [];
			const text = readFileSync(filePath, "utf8");
			const lines = text.split("\n").filter((l) => l.length > 0);
			const events: TodoStreamEvent[] = [];
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as TodoStreamEvent;
					if (
						parsed &&
						typeof parsed === "object" &&
						typeof parsed.id === "string" &&
						typeof parsed.kind === "string"
					) {
						events.push(parsed);
					}
				} catch {
					// Skip malformed line.
				}
			}
			return events;
		} catch (error) {
			console.warn("[todo-agent] stream load failed", error);
			return [];
		}
	}

	subscribeStream(
		sessionId: string,
		handler: (update: TodoStreamUpdate) => void,
	): () => void {
		const key = `stream:${sessionId}`;
		this.emitter.on(key, handler);
		return () => {
			this.emitter.off(key, handler);
		};
	}

	insert(
		row: Omit<SelectTodoSession, "id" | "createdAt" | "updatedAt"> & {
			id?: string;
		},
	): SelectTodoSession {
		const inserted = localDb.insert(todoSessions).values(row).returning().get();
		this.emit(inserted);
		return inserted;
	}

	/**
	 * Insert a fresh `queued` session from a user-authored template (TODO
	 * composer, schedule fire, or anywhere else that starts a new session
	 * from scratch). Centralizing this here keeps the full TodoSession row
	 * shape in one place — otherwise any new field on `todo_sessions` has
	 * to be remembered in every call site.
	 */
	insertQueuedFromTemplate(template: {
		id: string;
		projectId: string | null | undefined;
		workspaceId: string;
		title: string;
		description: string;
		goal?: string | null;
		verifyCommand?: string | null;
		maxIterations: number;
		maxWallClockSec: number;
		customSystemPrompt?: string | null;
		claudeModel?: string | null;
		claudeEffort?: string | null;
		artifactPath: string;
	}): SelectTodoSession {
		return this.insert({
			id: template.id,
			projectId: template.projectId ?? null,
			workspaceId: template.workspaceId,
			title: template.title,
			description: template.description,
			goal: template.goal ?? null,
			verifyCommand: template.verifyCommand ?? null,
			maxIterations: template.maxIterations,
			maxWallClockSec: template.maxWallClockSec,
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
			customSystemPrompt: template.customSystemPrompt ?? null,
			claudeModel: template.claudeModel ?? null,
			claudeEffort: template.claudeEffort ?? null,
			verdictPassed: null,
			verdictReason: null,
			verdictFailingTest: null,
			artifactPath: template.artifactPath,
			waitingUntil: null,
			waitingReason: null,
			startedAt: null,
			completedAt: null,
		});
	}

	get(sessionId: string): SelectTodoSession | undefined {
		return localDb
			.select()
			.from(todoSessions)
			.where(eq(todoSessions.id, sessionId))
			.get();
	}

	listForWorkspace(workspaceId: string): SelectTodoSession[] {
		return localDb
			.select()
			.from(todoSessions)
			.where(eq(todoSessions.workspaceId, workspaceId))
			.orderBy(desc(todoSessions.createdAt))
			.all();
	}

	/**
	 * Sessions parked in `waiting` whose `waitingUntil` deadline has
	 * passed. Drives the scheduler tick that resumes `ScheduleWakeup`-
	 * paused sessions once their delay elapses.
	 */
	listWaitingDue(nowMs: number): SelectTodoSession[] {
		return localDb
			.select()
			.from(todoSessions)
			.where(
				and(
					eq(todoSessions.status, "waiting"),
					lte(todoSessions.waitingUntil, nowMs),
				),
			)
			.all();
	}

	/**
	 * Atomically flip a row from `waiting` → `queued` and clear the
	 * parking fields. Returns the updated row (so callers can tell they
	 * won the claim) or undefined when the session has since moved to a
	 * different status — typically because the user clicked Abort while
	 * the scheduler tick was already in flight. Used as the race guard
	 * before the scheduler hands a session back to the supervisor.
	 */
	claimWaitingForResume(sessionId: string): SelectTodoSession | undefined {
		const updated = localDb
			.update(todoSessions)
			.set({
				status: "queued",
				phase: "queued",
				waitingUntil: null,
				waitingReason: null,
				updatedAt: Date.now(),
			})
			.where(
				and(eq(todoSessions.id, sessionId), eq(todoSessions.status, "waiting")),
			)
			.returning()
			.get();
		if (updated) this.emit(updated);
		return updated;
	}

	/**
	 * Cross-workspace list used by the Agent-Manager-style view. Joins in
	 * workspace + project names so the manager can group and label rows
	 * without issuing N extra queries. Deleted workspaces
	 * (`deletingAt IS NOT NULL`) are filtered out.
	 */
	listAll(): TodoSessionListEntry[] {
		const rows = localDb
			.select({
				session: todoSessions,
				workspaceName: workspaces.name,
				workspaceBranch: workspaces.branch,
				workspaceDeletingAt: workspaces.deletingAt,
				projectName: projects.name,
			})
			.from(todoSessions)
			.leftJoin(workspaces, eq(workspaces.id, todoSessions.workspaceId))
			.leftJoin(projects, eq(projects.id, workspaces.projectId))
			.where(isNull(workspaces.deletingAt))
			.orderBy(desc(todoSessions.createdAt))
			.all();
		return rows.map((row) => ({
			...row.session,
			workspaceName: row.workspaceName ?? null,
			workspaceBranch: row.workspaceBranch ?? null,
			projectName: row.projectName ?? null,
		}));
	}

	update(
		sessionId: string,
		patch: Partial<SelectTodoSession>,
	): SelectTodoSession | undefined {
		const next = {
			...patch,
			updatedAt: Date.now(),
		};
		const updated = localDb
			.update(todoSessions)
			.set(next)
			.where(eq(todoSessions.id, sessionId))
			.returning()
			.get();
		if (updated) this.emit(updated);
		return updated;
	}

	remove(sessionId: string): boolean {
		const result = localDb
			.delete(todoSessions)
			.where(eq(todoSessions.id, sessionId))
			.run();
		this.clearStreamEvents(sessionId);
		return result.changes > 0;
	}

	subscribe(
		sessionId: string,
		handler: (event: TodoSessionStateEvent) => void,
	): () => void {
		const key = `session:${sessionId}`;
		this.emitter.on(key, handler);
		return () => {
			this.emitter.off(key, handler);
		};
	}

	private emit(session: SelectTodoSession): void {
		const event: TodoSessionStateEvent = {
			sessionId: session.id,
			session,
		};
		this.emitter.emit(`session:${session.id}`, event);
	}

	/**
	 * Bridge hook used by the daemon client in the main process.
	 * The daemon writes to SQLite in its own process, so this store
	 * (living in the main process) does not observe those writes
	 * directly. The client re-emits them via this method so tRPC
	 * subscribers receive the update just like a local write.
	 */
	externalEmit(session: SelectTodoSession): void {
		this.emit(session);
	}

	/**
	 * Same idea as {@link externalEmit} but for stream-event appends:
	 * updates the in-memory buffer so `getStreamEvents` stays warm,
	 * then fans the update out to any subscribers.
	 */
	externalEmitStream(sessionId: string, events: TodoStreamEvent[]): void {
		if (events.length === 0) return;
		const buffer = this.streamBuffers.get(sessionId) ?? [];
		buffer.push(...events);
		if (buffer.length > STREAM_EVENT_BUFFER_CAP) {
			buffer.splice(0, buffer.length - STREAM_EVENT_BUFFER_CAP);
		}
		this.streamBuffers.set(sessionId, buffer);
		const update: TodoStreamUpdate = { sessionId, events };
		this.emitter.emit(`stream:${sessionId}`, update);
	}
}

let singleton: TodoSessionStore | undefined;

export function getTodoSessionStore(): TodoSessionStore {
	if (!singleton) singleton = new TodoSessionStore();
	return singleton;
}

/**
 * Resolve the absolute filesystem path a TODO session should run in for a
 * given workspace. For `type="worktree"` workspaces this is the worktree
 * path; for `type="branch"` workspaces there is no worktree row and we
 * fall back to the project's `mainRepoPath`, matching the resolution
 * strategy used by the existing terminal runtime in
 * `workspace-terminal-context.ts`. Returns undefined only when the
 * workspace does not exist.
 */
export function resolveWorktreePath(workspaceId: string): string | undefined {
	const row = localDb
		.select({
			worktreePath: worktrees.path,
			mainRepoPath: projects.mainRepoPath,
		})
		.from(workspaces)
		.leftJoin(projects, eq(projects.id, workspaces.projectId))
		.leftJoin(worktrees, eq(worktrees.id, workspaces.worktreeId))
		.where(eq(workspaces.id, workspaceId))
		.get();
	return row?.worktreePath ?? row?.mainRepoPath ?? undefined;
}

/**
 * Ensure a project has its `type="branch"` workspace (the row that maps
 * to `mainRepoPath`). Creates one lazily if missing so schedules with
 * no explicit workspaceId can attach their sessions to something real.
 * Returns the workspace id, or undefined if the project itself is gone.
 */
export function ensureProjectBranchWorkspaceId(
	projectId: string,
): string | undefined {
	const existing = localDb
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.projectId, projectId),
				eq(workspaces.type, "branch"),
				isNull(workspaces.deletingAt),
			),
		)
		.get();
	if (existing) return existing.id;

	const project = localDb
		.select({
			defaultBranch: projects.defaultBranch,
		})
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!project) return undefined;

	const branchName = project.defaultBranch ?? "main";
	const inserted = localDb
		.insert(workspaces)
		.values({
			projectId,
			type: "branch",
			branch: branchName,
			name: branchName,
			tabOrder: 0,
		})
		.onConflictDoNothing()
		.returning({ id: workspaces.id })
		.get();

	if (inserted) {
		// Mirror the standard workspace-create flow: bump every other
		// workspace in the project by +1 so the new branch workspace
		// lands uniquely at tabOrder 0 instead of colliding with an
		// existing 0-ordered worktree (which would yield a
		// non-deterministic sort in the sidebar).
		const siblings = localDb
			.select({ id: workspaces.id, tabOrder: workspaces.tabOrder })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.projectId, projectId),
					not(eq(workspaces.id, inserted.id)),
					isNull(workspaces.deletingAt),
				),
			)
			.all();
		for (const sibling of siblings) {
			localDb
				.update(workspaces)
				.set({ tabOrder: (sibling.tabOrder ?? 0) + 1 })
				.where(eq(workspaces.id, sibling.id))
				.run();
		}
		return inserted.id;
	}

	// Race: another path materialized it between our check and insert.
	const raced = localDb
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.projectId, projectId),
				eq(workspaces.type, "branch"),
				isNull(workspaces.deletingAt),
			),
		)
		.get();
	return raced?.id;
}
