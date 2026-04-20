import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Browser pane <-> LLM session bindings.
 *
 * Stored in local-db so bindings survive app restarts: the terminal daemon
 * re-attaches terminal panes on launch and TODO-Agent sessions keep running,
 * so losing the binding would leave the user to re-connect every launch.
 *
 * `sessionKind` records where the sessionId came from so the UI can dispatch
 * correctly when the bound session is no longer live.
 *   - "todo-agent": sessionId is `todoSessions.id`
 *   - "terminal":   sessionId is the terminal paneId that owns the claude/codex
 *                   process (so the binding self-heals across shell re-spawns
 *                   in the same pane).
 */
export const browserAutomationBindings = sqliteTable(
	"browser_automation_bindings",
	{
		paneId: text("pane_id").primaryKey(),
		sessionId: text("session_id").notNull(),
		sessionKind: text("session_kind").notNull().default("todo-agent"),
		connectedAt: integer("connected_at").notNull(),
	},
);

export type SelectBrowserAutomationBinding =
	typeof browserAutomationBindings.$inferSelect;
