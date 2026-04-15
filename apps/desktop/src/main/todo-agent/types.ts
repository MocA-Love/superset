import type { SelectTodoSession } from "@superset/local-db";
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
	maxWallClockSec: z.number().int().min(60).max(60 * 60 * 4).default(1800),
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

export const todoPresetCreateInputSchema = z.object({
	name: z.string().trim().min(1).max(120),
	content: z.string().trim().min(1).max(20_000),
});

export const todoPresetUpdateInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1).max(120),
	content: z.string().trim().min(1).max(20_000),
});

export const todoEnhanceTextInputSchema = z.object({
	text: z.string().trim().min(1).max(10_000),
	kind: z.enum(["description", "goal"]),
});

export type TodoEnhanceTextInput = z.infer<typeof todoEnhanceTextInputSchema>;

export type TodoCreateInput = z.infer<typeof todoCreateInputSchema>;

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
	| "paused";

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
