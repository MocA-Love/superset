import type {
	SelectTodoSchedule,
	SelectTodoSession,
	TodoScheduleFrequency,
	TodoScheduleOverlapMode,
} from "@superset/local-db";
import { z } from "zod";

/**
 * Row shape returned by the cross-workspace `todoAgent.listAll` query:
 * the session fields + the joined workspace / project names so the
 * Agent-Manager view can group and label rows without N+1 queries.
 */
export interface TodoSessionListEntry extends SelectTodoSession {
	workspaceName: string | null;
	workspaceBranch: string | null;
	projectName: string | null;
}

export const todoCreateInputSchema = z.object({
	workspaceId: z.string().min(1),
	projectId: z.string().optional(),
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(10_000),
	// Optional: when omitted, the session treats "やって欲しいこと
	// (description) が完了したとき" as the implicit goal.
	goal: z
		.string()
		.trim()
		.max(10_000)
		.optional()
		.transform((v) => (v && v.length > 0 ? v : undefined)),
	// Optional: when omitted, the session runs as a single-turn task
	// (research / investigation / one-shot). When provided, it is the
	// decisive gate for the iteration loop.
	verifyCommand: z
		.string()
		.trim()
		.max(10_000)
		.optional()
		.transform((v) => (v && v.length > 0 ? v : undefined)),
	maxIterations: z.number().int().min(1).max(100).default(10),
	maxWallClockSec: z
		.number()
		.int()
		.min(60)
		.max(60 * 60 * 4)
		.default(1800),
	// Optional free-form text the user attached at creation time,
	// usually pulled from a saved preset. Passed to claude via
	// `--append-system-prompt` so the session steering stays
	// consistent across iterations without having to repeat it in
	// every turn's prompt.
	customSystemPrompt: z
		.string()
		.trim()
		.max(20_000)
		.optional()
		.transform((v) => (v && v.length > 0 ? v : undefined)),
});

export const todoPresetKindSchema = z.enum(["system", "description", "goal"]);
export type TodoPresetKind = z.infer<typeof todoPresetKindSchema>;

export const todoPresetCreateInputSchema = z.object({
	name: z.string().trim().min(1).max(120),
	content: z.string().trim().min(1).max(20_000),
	kind: todoPresetKindSchema.default("system"),
	workspaceId: z.string().min(1).optional(),
});

export const todoPresetUpdateInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1).max(120),
	content: z.string().trim().min(1).max(20_000),
	kind: todoPresetKindSchema.optional(),
	workspaceId: z.string().min(1).nullable().optional(),
});

export const todoEnhanceTextInputSchema = z.object({
	text: z.string().trim().min(1).max(10_000),
	kind: z.enum(["description", "goal"]),
});

export type TodoEnhanceTextInput = z.infer<typeof todoEnhanceTextInputSchema>;

export type TodoCreateInput = z.infer<typeof todoCreateInputSchema>;

export const todoSettingsSchema = z.object({
	defaultMaxIterations: z.number().int().min(1).max(100).default(10),
	defaultMaxWallClockMin: z.number().int().min(1).max(240).default(30),
	maxConcurrentTasks: z.number().int().min(1).max(10).default(1),
	// 0 = 無制限 (手動削除のみ). 1-365 = その日数より古い終了済み
	// セッションを起動時に自動削除する (queued / running / paused は対象外)。
	sessionRetentionDays: z.number().int().min(0).max(365).default(0),
});

export type TodoSettings = z.infer<typeof todoSettingsSchema>;

export const todoSettingsUpdateSchema = todoSettingsSchema.partial();

export const todoAttachPaneInputSchema = z.object({
	sessionId: z.string().min(1),
	tabId: z.string().min(1),
	paneId: z.string().min(1),
});

export type TodoAttachPaneInput = z.infer<typeof todoAttachPaneInputSchema>;

export const todoSendInputSchema = z.object({
	sessionId: z.string().min(1),
	data: z.string().min(1),
});

export type TodoSendInput = z.infer<typeof todoSendInputSchema>;

/**
 * Event published on state changes so the tRPC subscription can fan out to
 * the renderer. Kept small and serializable.
 */
export interface TodoSessionStateEvent {
	sessionId: string;
	session: SelectTodoSession;
}

export type TodoSessionPhase =
	| "queued"
	| "preparing"
	| "running"
	| "verifying"
	| "done"
	| "failed"
	| "escalated"
	| "aborted"
	| "paused"
	| "waiting";

export const TODO_ARTIFACT_SUBDIR = ".superset/todo";

// ---- Headless stream-json events ----
//
// These types describe the NDJSON messages Claude Code emits on stdout when
// invoked with `-p --output-format stream-json`. We do not attempt to cover
// the full schema; we only name the shapes the TODO supervisor needs to
// reason about. Unknown event types fall through as the base `raw` variant.
// See: https://code.claude.com/docs/en/headless

export type TodoStreamEventKind =
	| "system_init"
	| "assistant_text"
	| "tool_use"
	| "tool_result"
	| "result"
	| "error"
	| "raw";

/**
 * One condensed event we store in the per-session in-memory buffer and send
 * over the subscription. Raw NDJSON is kept for the `raw` variant so the UI
 * can always show unparsed context for debugging.
 */
export interface TodoStreamEvent {
	/** Stable id so React can key on it without re-rendering siblings. */
	id: string;
	/** Millisecond timestamp when the event was observed by the supervisor. */
	ts: number;
	/** Turn number this event belongs to (1-based, bumped on each iteration). */
	iteration: number;
	kind: TodoStreamEventKind;
	/** One-line label used by the renderer (e.g. "User", "Claude", "Bash"). */
	label: string;
	/** Human-readable body text, already stripped of ANSI. */
	text: string;
	/** Optional raw payload for the "raw" / debug kind. */
	raw?: unknown;
}

export interface TodoStreamUpdate {
	sessionId: string;
	events: TodoStreamEvent[];
}

// ---- Schedules ----

export const todoScheduleFrequencySchema = z.enum([
	"hourly",
	"daily",
	"weekly",
	"monthly",
	"custom",
]);

export const todoScheduleOverlapModeSchema = z.enum(["skip", "queue"]);

export const todoScheduleCreateInputSchema = z
	.object({
		projectId: z.string().min(1),
		// Null/omitted means "run on the project's main repo path" (the
		// non-worktree source tree). Set to a workspace id to bind the
		// schedule to a specific worktree instead.
		workspaceId: z.string().min(1).nullish(),
		name: z.string().trim().min(1).max(120),
		enabled: z.boolean().default(true),
		frequency: todoScheduleFrequencySchema,
		minute: z.number().int().min(0).max(59).nullish(),
		hour: z.number().int().min(0).max(23).nullish(),
		weekday: z.number().int().min(0).max(6).nullish(),
		monthday: z.number().int().min(1).max(31).nullish(),
		cronExpr: z.string().trim().min(1).max(200).nullish(),
		title: z.string().trim().min(1).max(200),
		description: z.string().trim().min(1).max(10_000),
		goal: z.string().trim().max(10_000).nullish(),
		verifyCommand: z.string().trim().max(10_000).nullish(),
		maxIterations: z.number().int().min(1).max(100).default(10),
		maxWallClockSec: z
			.number()
			.int()
			.min(60)
			.max(60 * 60 * 4)
			.default(1800),
		customSystemPrompt: z.string().trim().max(20_000).nullish(),
		overlapMode: todoScheduleOverlapModeSchema.default("skip"),
		autoSyncBeforeFire: z.boolean().default(false),
	})
	.refine(
		(v) =>
			v.frequency !== "custom" ||
			(typeof v.cronExpr === "string" && v.cronExpr.length > 0),
		{
			message: "cronExpr is required when frequency is 'custom'",
			path: ["cronExpr"],
		},
	);

export type TodoScheduleCreateInput = z.infer<
	typeof todoScheduleCreateInputSchema
>;

const todoScheduleBaseSchema = z.object({
	projectId: z.string().min(1),
	workspaceId: z.string().min(1).nullish(),
	name: z.string().trim().min(1).max(120),
	enabled: z.boolean(),
	frequency: todoScheduleFrequencySchema,
	minute: z.number().int().min(0).max(59).nullish(),
	hour: z.number().int().min(0).max(23).nullish(),
	weekday: z.number().int().min(0).max(6).nullish(),
	monthday: z.number().int().min(1).max(31).nullish(),
	cronExpr: z.string().trim().min(1).max(200).nullish(),
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().min(1).max(10_000),
	goal: z.string().trim().max(10_000).nullish(),
	verifyCommand: z.string().trim().max(10_000).nullish(),
	maxIterations: z.number().int().min(1).max(100),
	maxWallClockSec: z
		.number()
		.int()
		.min(60)
		.max(60 * 60 * 4),
	customSystemPrompt: z.string().trim().max(20_000).nullish(),
	overlapMode: todoScheduleOverlapModeSchema,
	autoSyncBeforeFire: z.boolean(),
});

// projectId is intentionally omitted from the update surface: a schedule's
// project is immutable, otherwise `lastRunSessionId` could point at a
// session from a different project than the schedule currently belongs to.
// Users who want to move a schedule to another project should recreate it.
export const todoScheduleUpdateInputSchema = todoScheduleBaseSchema
	.omit({ projectId: true })
	.partial()
	.extend({ id: z.string().min(1) });

export type TodoScheduleUpdateInput = z.infer<
	typeof todoScheduleUpdateInputSchema
>;

/**
 * Event emitted by the scheduler when a schedule fires. The renderer uses
 * this to show a toast and, when `sessionId` is non-null, deep-link to the
 * freshly-created session.
 */
export type TodoScheduleFireKind = "triggered" | "skipped" | "failed";

export interface TodoScheduleFireEvent {
	scheduleId: string;
	scheduleName: string;
	kind: TodoScheduleFireKind;
	sessionId: string | null;
	message: string | null;
	firedAt: number;
}

export type {
	SelectTodoSchedule,
	TodoScheduleFrequency,
	TodoScheduleOverlapMode,
};
