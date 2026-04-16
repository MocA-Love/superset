import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * One-shot sweep of `userData/todo-agent/attachments/` at app startup.
 * Removes any file whose mtime is older than 30 days so pasted
 * screenshots do not accumulate forever. 30 days gives plenty of
 * buffer for long-running TODO sessions to reference their images;
 * sessions that have already been archived lose nothing that is
 * still reachable.
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
		const cutoff = Date.now() - ATTACHMENT_TTL_MS;
		let removed = 0;
		for (const name of entries) {
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
