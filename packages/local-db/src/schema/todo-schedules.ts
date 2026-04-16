import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

import { projects, workspaces } from "./schema";

/**
 * TODO autonomous agent schedules.
 *
 * Each row defines a recurring trigger that creates a new todoSessions row
 * (based on the template fields here) at its configured cadence. The runtime
 * scheduler lives in the main process; this table is just persistent state.
 * Fork-local feature; see apps/desktop/plans/20260416-todo-schedule.md.
 */
export const todoSchedules = sqliteTable(
	"todo_schedules",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, {
				onDelete: "cascade",
			}),
		// Optional: when null, the schedule fires against the project's
		// main repo path (`projects.mainRepoPath`) instead of a specific
		// worktree. Needed for "run on main every day" use cases where
		// the user doesn't want to maintain a dedicated workspace row.
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),

		name: text("name").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

		// Frequency definition. For hourly/daily/weekly/monthly the scheduler
		// derives the next fire from `minute`/`hour`/`weekday`/`monthday`
		// without touching a cron parser. `custom` delegates to `cronExpr`.
		frequency: text("frequency", {
			enum: ["hourly", "daily", "weekly", "monthly", "custom"],
		}).notNull(),
		minute: integer("minute"),
		hour: integer("hour"),
		weekday: integer("weekday"),
		monthday: integer("monthday"),
		cronExpr: text("cron_expr"),

		// TODO session template. Mirrors the session's own schema so that
		// creating a session from a schedule is a straight copy.
		title: text("title").notNull(),
		description: text("description").notNull(),
		goal: text("goal"),
		verifyCommand: text("verify_command"),
		maxIterations: integer("max_iterations").notNull().default(10),
		maxWallClockSec: integer("max_wall_clock_sec").notNull().default(1800),
		customSystemPrompt: text("custom_system_prompt"),

		// How to behave when the previous session from this schedule is
		// still running at fire time.
		overlapMode: text("overlap_mode", { enum: ["skip", "queue"] })
			.notNull()
			.default("skip"),

		// Opt-in: before firing on the project's main repo path, do
		// `git fetch && git checkout <defaultBranch> && git pull
		// --ff-only`. If the working tree has uncommitted changes the
		// scheduler skips the fire rather than risk destroying the
		// user's work. Only applies when workspaceId is null (project
		// main repo mode); worktree workspaces are unaffected.
		autoSyncBeforeFire: integer("auto_sync_before_fire", { mode: "boolean" })
			.notNull()
			.default(false),

		lastRunAt: integer("last_run_at"),
		lastRunSessionId: text("last_run_session_id"),
		// Cached next fire time so the scheduler can cheaply scan "due"
		// schedules in a single query instead of recomputing cadence on
		// every tick.
		nextRunAt: integer("next_run_at"),

		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("todo_schedules_project_idx").on(table.projectId),
		index("todo_schedules_workspace_idx").on(table.workspaceId),
		index("todo_schedules_enabled_next_run_idx").on(
			table.enabled,
			table.nextRunAt,
		),
	],
);

export type InsertTodoSchedule = typeof todoSchedules.$inferInsert;
export type SelectTodoSchedule = typeof todoSchedules.$inferSelect;

export const todoScheduleFrequencyValues = [
	"hourly",
	"daily",
	"weekly",
	"monthly",
	"custom",
] as const;

export type TodoScheduleFrequency =
	(typeof todoScheduleFrequencyValues)[number];

export const todoScheduleOverlapModeValues = ["skip", "queue"] as const;

export type TodoScheduleOverlapMode =
	(typeof todoScheduleOverlapModeValues)[number];
