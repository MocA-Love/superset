import { EventEmitter } from "node:events";
import {
	type SelectTodoSession,
	todoSessions,
	workspaces,
	worktrees,
} from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import type { TodoSessionStateEvent } from "./types";

/**
 * In-memory session bookkeeping + persistence helpers for the TODO agent.
 *
 * All state transitions go through `updateSession` so we have exactly one
 * place that writes to the DB and emits the state event consumed by the
 * tRPC subscription.
 */
class TodoSessionStore {
	private readonly emitter = new EventEmitter();

	constructor() {
		this.emitter.setMaxListeners(0);
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
			.all();
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
 * Resolve the absolute worktree path for a workspace. Returns undefined if
 * the workspace is branch-typed (no worktree) or does not exist.
 */
export function resolveWorktreePath(workspaceId: string): string | undefined {
	const row = localDb
		.select({ path: worktrees.path })
		.from(workspaces)
		.leftJoin(worktrees, eq(worktrees.id, workspaces.worktreeId))
		.where(eq(workspaces.id, workspaceId))
		.get();
	return row?.path ?? undefined;
}
