/**
 * TODO Agent Daemon Protocol Types
 *
 * IPC protocol between the Electron main process and the todo-agent daemon.
 * Changes must be additive-only for backwards compatibility.
 *
 * The daemon owns `claude -p` child processes so they survive app
 * restarts. Issue #237.
 */

import type { SelectTodoSession } from "@superset/local-db";
import type { TodoStreamEvent } from "main/todo-agent/types";

export const TODO_DAEMON_PROTOCOL_VERSION = 1;

// =============================================================================
// IPC Framing
// =============================================================================

export interface IpcRequest {
	id: string;
	type: string;
	payload: unknown;
}

export interface IpcSuccessResponse {
	id: string;
	ok: true;
	payload: unknown;
}

export interface IpcErrorResponse {
	id: string;
	ok: false;
	error: {
		code: string;
		message: string;
	};
}

export type IpcResponse = IpcSuccessResponse | IpcErrorResponse;

export interface IpcEvent {
	type: "event";
	event: string;
	payload: unknown;
}

// =============================================================================
// Request / Response Payloads
// =============================================================================

export interface HelloRequest {
	protocolVersion: number;
	token: string;
}

export interface HelloResponse {
	protocolVersion: number;
	daemonVersion: string;
	daemonPid: number;
	/** IDs of sessions the daemon is actively driving right now. */
	activeSessionIds: string[];
}

export interface StartRequest {
	sessionId: string;
	/**
	 * True when the caller is the scheduler waking a `ScheduleWakeup`-
	 * paused session back up. The engine consumes this marker to skip
	 * the "再開" banner and to send a short continuation prompt instead
	 * of replaying the original goal — see issue #240.
	 */
	fromScheduledWakeup?: boolean;
}

export interface AbortRequest {
	sessionId: string;
}

export interface QueueInterventionRequest {
	sessionId: string;
	data: string;
}

export interface ResumeWaitingRequest {
	/** Session IDs the scheduler has already claimed (flipped to queued). */
	sessionIds: string[];
}

export type SettingsChangedRequest = Record<string, never>;

export type RehydrateRequest = Record<string, never>;

export interface ListActiveResponse {
	sessionIds: string[];
}

export interface ShutdownRequest {
	/** If true, the daemon SIGINTs all in-flight claude children before exiting. */
	killSessions?: boolean;
}

export interface EmptyResponse {
	success: true;
}

// =============================================================================
// Event Payloads (daemon → main)
// =============================================================================

/** Fired when the daemon writes to a `todo_sessions` row. */
export interface SessionStateEventPayload {
	session: SelectTodoSession;
}

/** Fired when the daemon appends stream events for a session. */
export interface SessionStreamEventPayload {
	sessionId: string;
	events: TodoStreamEvent[];
}

// =============================================================================
// Type Map
// =============================================================================

export type RequestTypeMap = {
	hello: { request: HelloRequest; response: HelloResponse };
	start: { request: StartRequest; response: EmptyResponse };
	abort: { request: AbortRequest; response: EmptyResponse };
	queueIntervention: {
		request: QueueInterventionRequest;
		response: EmptyResponse;
	};
	resumeWaiting: { request: ResumeWaitingRequest; response: EmptyResponse };
	settingsChanged: {
		request: SettingsChangedRequest;
		response: EmptyResponse;
	};
	rehydrate: { request: RehydrateRequest; response: EmptyResponse };
	listActive: { request: undefined; response: ListActiveResponse };
	shutdown: { request: ShutdownRequest; response: EmptyResponse };
};

export type EventTypeMap = {
	sessionState: SessionStateEventPayload;
	streamEvents: SessionStreamEventPayload;
};
