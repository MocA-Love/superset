import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { todoSessions } from "@superset/local-db";
import { app } from "electron";
import { localDb } from "main/lib/local-db";

const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * One-shot sweep of `userData/todo-agent/attachments/` at app startup.
 * Removes any file that is BOTH:
 *
 *   - older than 30 days (mtime), AND
 *   - not referenced by any `todo_sessions` row's description /
 *     goal / pendingIntervention / customSystemPrompt / finalAssistantText
 *     / verdictReason
 *
 * The age guard keeps the cache from growing forever while the
 * reference check protects images attached to long-running or
 * recently-resumed TODOs — those can still predate the 30-day
 * window if the user revives an older session.
 */
export function cleanupOldAttachments(): void {
	try {
		const dir = path.join(app.getPath("userData"), "todo-agent", "attachments");
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			// Directory doesn't exist yet — nothing to do.
			return;
		}

		// Build a set of filenames that are still referenced by any
		// session's text columns. We only care about the file *basename*
		// — that's unique per attachment (uuid-prefixed) and avoids
		// false positives from substring matching elsewhere in the
		// prompt text.
		const referenced = new Set<string>();
		try {
			const rows = localDb
				.select({
					description: todoSessions.description,
					goal: todoSessions.goal,
					pendingIntervention: todoSessions.pendingIntervention,
					customSystemPrompt: todoSessions.customSystemPrompt,
					finalAssistantText: todoSessions.finalAssistantText,
					verdictReason: todoSessions.verdictReason,
				})
				.from(todoSessions)
				.all();
			// Match only our own attachment filenames — the save path
			// always prefixes a UUID, so the pattern is narrow enough
			// to avoid false positives from unrelated paths that happen
			// to contain "attachments" in prompt text. Works across
			// POSIX / Windows by allowing either separator.
			const filenameRe =
				/[/\\]attachments[/\\]([0-9a-f-]{36}-[^\s"'<>()\]]+)/gi;
			for (const row of rows) {
				for (const text of [
					row.description,
					row.goal,
					row.pendingIntervention,
					row.customSystemPrompt,
					row.finalAssistantText,
					row.verdictReason,
				]) {
					if (!text) continue;
					for (const m of text.matchAll(filenameRe)) {
						if (m[1]) referenced.add(m[1]);
					}
				}
			}
		} catch (error) {
			// If the reference scan fails for any reason, bail out of
			// cleanup entirely — better to keep orphans than to delete
			// something that turns out to be referenced.
			console.warn(
				"[todo-agent] attachment reference scan failed, skipping cleanup",
				error,
			);
			return;
		}

		const cutoff = Date.now() - ATTACHMENT_TTL_MS;
		let removed = 0;
		for (const name of entries) {
			if (referenced.has(name)) continue;
			const full = path.join(dir, name);
			try {
				const st = statSync(full);
				if (!st.isFile()) continue;
				if (st.mtimeMs < cutoff) {
					unlinkSync(full);
					removed += 1;
				}
			} catch {
				// Ignore individual file errors; continue the sweep.
			}
		}
		if (removed > 0) {
			console.log(`[todo-agent] purged ${removed} stale attachment(s)`);
		}
	} catch (error) {
		console.warn("[todo-agent] attachment cleanup failed", error);
	}
}
