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

// ---- Agent kind ----

export const AGENT_KIND_OPTIONS = ["claude", "codex", "crush"] as const;
export type AgentKind = (typeof AGENT_KIND_OPTIONS)[number];
export const agentKindSchema = z.enum(AGENT_KIND_OPTIONS);
export const DEFAULT_AGENT_KIND: AgentKind = "claude";

/**
 * Codex CLI `--model` values we allow the user to pick from the UI.
 * Codex uses OpenAI model identifiers directly. Kept open-ended (plus a
 * default `null` in the storage layer) so new models do not require a
 * migration. `default` is the UI-side sentinel that maps to `null` (don't
 * pass `--model` at all; let Codex use whatever the user's own config chose).
 */
export const CODEX_MODEL_OPTIONS = [
	"gpt-5.4",
	"gpt-5.2-codex",
	"gpt-5.1-codex-max",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.2",
	"gpt-5.1-codex-mini",
] as const;

export type TodoCodexModel = (typeof CODEX_MODEL_OPTIONS)[number];

export const todoCodexModelSchema = z.enum(CODEX_MODEL_OPTIONS);

/**
 * Codex CLI `model_reasoning_effort` config values. Mirrors the Codex Rust
 * source `ReasoningEffort` enum: none / minimal / low / medium / high / xhigh.
 * UI-side sentinel `__default__` maps to `null` (don't override).
 */
export const CODEX_EFFORT_OPTIONS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type TodoCodexEffort = (typeof CODEX_EFFORT_OPTIONS)[number];

export const todoCodexEffortSchema = z.enum(CODEX_EFFORT_OPTIONS);

// ---- Claude Code model / effort options ----

/**
 * Claude Code `--model` values we allow the user to pick from the UI.
 * Aliases cover "latest of this tier"; full model names pin a specific
 * release. Kept open-ended (plus a default `null` in the storage layer)
 * so new models do not require a migration. `default` is the UI-side
 * sentinel that maps to `null` (don't pass `--model` at all; let Claude
 * Code use whatever the user's own config / ~/.claude.json chose).
 */
export const CLAUDE_MODEL_OPTIONS = [
	"opus",
	"sonnet",
	"haiku",
	"claude-opus-4-7",
	"claude-sonnet-4-6",
	"claude-haiku-4-5-20251001",
] as const;

export type TodoClaudeModel = (typeof CLAUDE_MODEL_OPTIONS)[number];

export const todoClaudeModelSchema = z.enum(CLAUDE_MODEL_OPTIONS);

/**
 * Claude Code `--effort` levels. `default` is the UI-side sentinel for
 * "don't pass the flag"; actual persisted values are `low`..`max` or
 * null.
 *
 * Thinking support is model-gated in Claude Code; the CLI rejects an
 * incompatible effort level at launch. We intentionally don't duplicate
 * that matrix here so adding a new model tier on the CLI side doesn't
 * require a fork update. The UI surfaces a warning but allows the
 * combination; the supervisor forwards whatever the user picked.
 */
export const CLAUDE_EFFORT_OPTIONS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type TodoClaudeEffort = (typeof CLAUDE_EFFORT_OPTIONS)[number];

export const todoClaudeEffortSchema = z.enum(CLAUDE_EFFORT_OPTIONS);

export const todoCreateInputSchema = z.object({
	workspaceId: z.string().min(1),
	projectId: z.string().optional(),
	title: z.string().trim().max(200).optional(),
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
	// usually pulled from a saved preset. For Claude Code sessions,
	// passed via `--append-system-prompt`. For Codex sessions, passed
	// via `--developer-instructions`.
	customSystemPrompt: z
		.string()
		.trim()
		.max(20_000)
		.optional()
		.transform((v) => (v && v.length > 0 ? v : undefined)),
	// Which agent CLI to use for this session. When omitted/undefined,
	// the tRPC router resolves from the user's configured default.
	agentKind: agentKindSchema.optional(),
	// Optional per-session Claude Code CLI overrides. Null / undefined
	// means "use the user's configured default" (see todoSettingsSchema).
	claudeModel: todoClaudeModelSchema.nullish(),
	claudeEffort: todoClaudeEffortSchema.nullish(),
	// Optional per-session Codex CLI overrides. Null / undefined means
	// "use the user's configured default". Only read when agentKind is
	// "codex"; ignored for Claude sessions.
	codexModel: todoCodexModelSchema.nullish(),
	codexEffort: todoCodexEffortSchema.nullish(),
	// Optional per-session Crush CLI model override. Null / undefined means
	// "use the user's configured default". Only read when agentKind is
	// "crush"; ignored for Claude / Codex sessions. The value is a free-form
	// string in the form "provider/model" (e.g. "openai/gpt-5.4") resolved
	// dynamically from `crush models`. No effort option — Crush CLI lacks one.
	crushModel: z.string().trim().max(200).nullish(),
	// Beta escape hatch: opt a single TODO into the interactive PTY
	// engine without flipping the whole app over from headless `-p`.
	// Persisted in the artifact runtime config, not the DB row.
	// Claude Code only — Codex always uses headless exec mode.
	ptyEnabled: z.boolean().optional().default(false),
	// When true, the PTY runner sends `/remote-control` after spawn so
	// the session becomes reachable from claude.ai/code / Claude mobile.
	// Requires `ptyEnabled=true`; the UI prevents invalid combinations.
	// Claude Code only.
	remoteControlEnabled: z.boolean().optional().default(false),
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
	// Default agent CLI for new TODO sessions.
	defaultAgentKind: agentKindSchema.default(DEFAULT_AGENT_KIND),
	// Global defaults used when the TODO composer / ScheduleEditor does
	// not override them. Null = let Claude Code resolve its own default
	// (user config cascade). Stored as nullable so the user can pick
	// "default" in the settings UI.
	defaultClaudeModel: todoClaudeModelSchema.nullish().default(null),
	defaultClaudeEffort: todoClaudeEffortSchema.nullish().default(null),
	// Global defaults for Codex sessions.
	defaultCodexModel: todoCodexModelSchema.nullish().default(null),
	defaultCodexEffort: todoCodexEffortSchema.nullish().default(null),
	// Global default for Crush sessions. Free-form string ("provider/model").
	defaultCrushModel: z.string().trim().max(200).nullish().default(null),
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
	| "raw"
	// PTY engine (`TODO_ENGINE=pty`) emits these when Remote Control is
	// enabled on the session. `remote_control` carries the connection URL
	// (`https://claude.ai/code/session_...`) the UI surfaces as a badge;
	// `remote_control_error` is non-fatal — the turn continues without RC.
	// See apps/desktop/plans/20260417-todo-agent-remote-control.md.
	| "remote_control"
	| "remote_control_error";

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
	/**
	 * The Anthropic tool-use block id this event corresponds to.
	 * - For `tool_use` events: the id of the tool_use content block.
	 * - For `tool_result` events: the `tool_use_id` the result answers.
	 * Lets the UI pair tool_use ↔ tool_result by id instead of position,
	 * which is robust to concurrent / out-of-order SDK emissions.
	 */
	toolUseId?: string;
	/**
	 * Set on messages emitted from inside a subagent's context (i.e. when
	 * the main session invoked the `Task`/`Agent` tool). Its value is the
	 * tool_use id of the parent Agent tool call. The UI uses this to nest
	 * sub-tool activity under the parent Agent card, matching the VSCode
	 * Claude Code extension's presentation.
	 * See: https://docs.claude.com/en/docs/agent-sdk/ (Subagents)
	 */
	parentToolUseId?: string;
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
		claudeModel: todoClaudeModelSchema.nullish(),
		claudeEffort: todoClaudeEffortSchema.nullish(),
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
	claudeModel: todoClaudeModelSchema.nullish(),
	claudeEffort: todoClaudeEffortSchema.nullish(),
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
