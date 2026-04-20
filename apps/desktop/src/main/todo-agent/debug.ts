import type { SelectTodoSession } from "@superset/local-db";
import { createMainDebugChannel } from "../lib/debug-channel";
import type { TodoStreamEvent } from "./types";

const DEBUG_TODO_AGENT = process.env.SUPERSET_TODO_DEBUG === "1";

// TODO Agent の作成から daemon 実行、PTY / Remote Control 分岐までを
// 一回の Sentry ログで追えるようにするための main/daemon 共通 logger。
// 主に見たいのは:
// - renderer から送った PTY / Remote の意図が main で落ちていないか
// - runtime-config.json に正しく保存 / 読み出しできたか
// - daemon が headless / PTY / Remote Control をどう最終判定したか
// - PTY 起動後に Remote Control URL 発行まで進んだか
// Sentry には常時送り、console ミラーだけ env フラグで制御する。
export const todoAgentMainDebug = createMainDebugChannel({
	namespace: "todo.agent.main",
	enabled: true,
	mirrorToConsole: DEBUG_TODO_AGENT,
});

export function getTodoSessionDebugData(
	session: Pick<
		SelectTodoSession,
		| "id"
		| "workspaceId"
		| "projectId"
		| "status"
		| "phase"
		| "iteration"
		| "artifactPath"
		| "remoteControlEnabled"
		| "claudeSessionId"
		| "verdictReason"
		| "waitingReason"
	>,
) {
	return {
		sessionId: session.id,
		workspaceId: session.workspaceId,
		projectId: session.projectId ?? null,
		status: session.status,
		phase: session.phase,
		iteration: session.iteration,
		artifactPath: session.artifactPath,
		remoteControlEnabled: session.remoteControlEnabled ?? false,
		hasClaudeSessionId: Boolean(session.claudeSessionId),
		verdictReason: session.verdictReason ?? null,
		waitingReason: session.waitingReason ?? null,
	};
}

export function getTodoStreamEventDebugData(
	event: Pick<TodoStreamEvent, "id" | "iteration" | "kind" | "label" | "text">,
) {
	return {
		eventId: event.id,
		iteration: event.iteration,
		kind: event.kind,
		label: event.label,
		textPreview: event.text,
	};
}

export function getTodoStreamBatchDebugData(
	sessionId: string,
	events: readonly Pick<TodoStreamEvent, "kind">[],
) {
	const kinds = Array.from(new Set(events.map((event) => event.kind)));
	const lastEvent = events.length > 0 ? events[events.length - 1] : null;
	return {
		sessionId,
		eventCount: events.length,
		eventKinds: kinds.join(","),
		firstKind: events[0]?.kind ?? null,
		lastKind: lastEvent?.kind ?? null,
	};
}
