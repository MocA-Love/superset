import { existsSync, rmSync } from "node:fs";
import { todoSessions } from "@superset/local-db";
import { and, inArray, lt } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { getTodoSettings } from "./settings";

const TERMINAL_STATUSES = ["done", "failed", "aborted", "escalated"] as const;

/**
 * One-shot sweep of old terminal TODO sessions at app startup.
 *
 * Respects `todo-agent-settings.sessionRetentionDays`:
 *   - 0 (default) → no automatic deletion (legacy behavior)
 *   - N > 0       → delete sessions whose `completedAt` (or createdAt
 *                   fallback for rows that finished without a timestamp)
 *                   is older than N days AND whose status is terminal.
 *
 * Running / queued / paused / verifying / preparing sessions are NEVER
 * touched — they're active user work. The session's artifact directory
 * (`artifactPath`) is removed alongside the row.
 */
export function cleanupOldSessions(): void {
	try {
		const { sessionRetentionDays } = getTodoSettings();
		if (sessionRetentionDays <= 0) return;

		const cutoffMs = Date.now() - sessionRetentionDays * 24 * 60 * 60 * 1000;

		const candidates = localDb
			.select({
				id: todoSessions.id,
				artifactPath: todoSessions.artifactPath,
			})
			.from(todoSessions)
			.where(
				and(
					inArray(todoSessions.status, [...TERMINAL_STATUSES]),
					lt(todoSessions.createdAt, cutoffMs),
				),
			)
			.all();

		if (candidates.length === 0) return;

		// Delete rows in a single DB call so we don't thrash the journal
		// if the retention window has hundreds of pending deletes.
		localDb
			.delete(todoSessions)
			.where(
				inArray(
					todoSessions.id,
					candidates.map((row) => row.id),
				),
			)
			.run();

		for (const row of candidates) {
			if (!row.artifactPath) continue;
			try {
				if (existsSync(row.artifactPath)) {
					rmSync(row.artifactPath, { recursive: true, force: true });
				}
			} catch (error) {
				console.warn(
					"[todo-agent] failed to remove session artifact:",
					row.artifactPath,
					error,
				);
			}
		}

		console.log(
			`[todo-agent] cleaned up ${candidates.length} session(s) older than ${sessionRetentionDays} days`,
		);
	} catch (error) {
		console.warn("[todo-agent] session cleanup failed:", error);
	}
}
