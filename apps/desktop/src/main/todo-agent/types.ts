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
export const DEFAULT_IDLE_WINDOW_MS = 5_000;
export const MIN_IDLE_BEFORE_VERIFY_MS = 3_000;
