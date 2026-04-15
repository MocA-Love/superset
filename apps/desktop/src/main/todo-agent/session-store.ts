import { EventEmitter } from "node:events";
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
} from "./types";

export type { TodoSessionListEntry };

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
