import {
	index,
	integer,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
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

		// Claude Code headless session id captured from the stream-json
		// `system.init` event. Used as `--resume` for retry iterations so
		// subsequent turns share the same conversation state with Claude.
		claudeSessionId: text("claude_session_id"),

		// The actual final assistant message captured from the stream-json
		// `result` event. This is what the user sees as the verdict text
		// instead of the previous static placeholder.
		finalAssistantText: text("final_assistant_text"),

		// Aggregated cost / token / turn counters captured from the
		// `result` event across all iterations. Nullable because they are
		// only known after at least one iteration has completed.
		totalCostUsd: real("total_cost_usd"),
		totalNumTurns: integer("total_num_turns"),

		// Free-form text the user types in the Manager's intervene box.
		// Supervisor reads-then-clears this at the next turn boundary and
		// prepends it to the follow-up prompt so users can steer the
		// agent mid-run without needing mid-stream injection.
		pendingIntervention: text("pending_intervention"),

		// Git HEAD SHA captured at the moment the supervisor started this
		// session's run. Used as the base for "commits made in this
		// session" queries (git log <sha>..HEAD) so the Manager's right
		// sidebar can show exactly what the worker produced without
		// including unrelated user commits in the same worktree.
		startHeadSha: text("start_head_sha"),

		// Optional system prompt the user attached at creation time —
		// usually pulled from a saved preset. Passed to claude via
		// `--append-system-prompt` so it stacks on top of whatever
		// CLAUDE.md / workspace context already applies.
		customSystemPrompt: text("custom_system_prompt"),

		// Optional per-session Claude Code model + effort overrides. When
		// null, the supervisor omits the corresponding `--model` /
		// `--effort` flag and lets Claude Code use its resolved default
		// (user config + upstream default cascade). Values are free-form
		// strings so we can persist either an alias (`opus`, `sonnet`)
		// or a full model name (`claude-opus-4-7`) without a migration
		// every time Anthropic ships a new tier. The UI constrains the
		// allowed values.
		claudeModel: text("claude_model"),
		claudeEffort: text("claude_effort"),

		verdictPassed: integer("verdict_passed", { mode: "boolean" }),
		verdictReason: text("verdict_reason"),
		verdictFailingTest: text("verdict_failing_test"),

		artifactPath: text("artifact_path").notNull(),

		// Populated when the session is in the `waiting` state — i.e. the
		// underlying Claude Code worker called `ScheduleWakeup` (or another
		// self-pacing primitive) to pause itself until a specific wall-clock
		// time. The scheduler tick flips the session back into the run queue
		// once this timestamp has passed. Null whenever the session is not
		// waiting. Paired with `waitingReason` for the rationale Claude gave.
		waitingUntil: integer("waiting_until"),
		waitingReason: text("waiting_reason"),

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
	"waiting",
] as const;

export type TodoSessionStatus = (typeof todoSessionStatusValues)[number];
