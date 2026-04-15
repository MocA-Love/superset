import { EventEmitter } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import path from "node:path";
import {
	projects,
	type SelectTodoSession,
	todoSessions,
	workspaces,
	worktrees,
} from "@superset/local-db";
import { desc, eq, isNull } from "drizzle-orm";
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

	constructor() {
		this.emitter.setMaxListeners(0);
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
		try {
			const session = this.get(sessionId);
			const dir = session?.artifactPath;
			if (!dir || !dir.startsWith("/")) return;
			mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, STREAM_JSONL_FILE);
			const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			appendFileSync(filePath, body, "utf8");
		} catch (error) {
			console.warn("[todo-agent] stream persist failed", error);
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

	insert(row: Omit<SelectTodoSession, "id" | "createdAt" | "updatedAt"> & {
		id?: string;
	}): SelectTodoSession {
		const inserted = localDb
			.insert(todoSessions)
			.values(row)
			.returning()
			.get();
		this.emit(inserted);
		return inserted;
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
