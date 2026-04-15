import type { SelectTodoSession } from "@superset/local-db";
import { z } from "zod";

export const todoCreateInputSchema = z.object({
	workspaceId: z.string().min(1),
	projectId: z.string().optional(),
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(10_000),
	goal: z.string().min(1).max(10_000),
	verifyCommand: z.string().min(1).default("bun test"),
	maxIterations: z.number().int().min(1).max(100).default(10),
	maxWallClockSec: z.number().int().min(60).max(60 * 60 * 4).default(1800),
});

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
