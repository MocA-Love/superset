import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

import { projects, workspaces } from "./schema";

/**
 * TODO autonomous agent sessions.
 *
 * Each row represents a user-defined autonomous Claude Code task that runs
 * inside a workspace until a verify command passes or a budget/futility
 * guard trips. Fork-local feature; see apps/desktop/plans/todo-agent-plan.md.
 */
export const todoSessions = sqliteTable(
	"todo_sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),

		title: text("title").notNull(),
		description: text("description").notNull(),
		// Nullable: when omitted, the session treats "description completed"
		// as the implicit goal. Keeps the UX friction low for investigation
		// tasks where the user does not have a crisp acceptance sentence.
		goal: text("goal"),
		// Nullable: when absent, the session runs as a single-turn task
		// (no iteration loop, no decisive gate). Used for research /
		// investigation / single-shot work where there is no sensible
		// acceptance command.
		verifyCommand: text("verify_command"),

		maxIterations: integer("max_iterations").notNull().default(10),
		maxWallClockSec: integer("max_wall_clock_sec").notNull().default(1800),

		status: text("status").notNull().default("queued"),
		phase: text("phase"),
		iteration: integer("iteration").notNull().default(0),

		attachedPaneId: text("attached_pane_id"),
		attachedTabId: text("attached_tab_id"),

		verdictPassed: integer("verdict_passed", { mode: "boolean" }),
		verdictReason: text("verdict_reason"),
		verdictFailingTest: text("verdict_failing_test"),

		artifactPath: text("artifact_path").notNull(),

		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		startedAt: integer("started_at"),
		completedAt: integer("completed_at"),
	},
	(table) => [
		index("todo_sessions_workspace_idx").on(table.workspaceId),
		index("todo_sessions_status_idx").on(table.status),
		index("todo_sessions_created_at_idx").on(table.createdAt),
	],
);

export type InsertTodoSession = typeof todoSessions.$inferInsert;
export type SelectTodoSession = typeof todoSessions.$inferSelect;

export const todoSessionStatusValues = [
	"queued",
	"preparing",
	"running",
	"verifying",
	"done",
	"failed",
	"escalated",
	"aborted",
	"paused",
] as const;

export type TodoSessionStatus = (typeof todoSessionStatusValues)[number];
