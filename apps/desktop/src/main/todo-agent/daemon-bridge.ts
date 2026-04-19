import {
	disposeTodoDaemonClient,
	getTodoDaemonClient,
} from "main/lib/todo-daemon/client";
import {
	getTodoSessionDebugData,
	getTodoStreamBatchDebugData,
	getTodoStreamEventDebugData,
	todoAgentMainDebug,
} from "./debug";
import { getTodoSessionStore } from "./session-store";

/**
 * Wire the daemon client to the main-process session-store so tRPC
 * subscribers see updates that the daemon writes from its own DB
 * connection. Also issues a one-shot `rehydrate` so any session that
 * was running when the previous daemon died gets marked `failed`.
 *
 * Safe to call multiple times; second and later calls are no-ops.
 */
let wired = false;
let connectPromise: Promise<void> | null = null;

export function startTodoAgentDaemonBridge(): Promise<void> {
	if (connectPromise) return connectPromise;
	const client = getTodoDaemonClient();
	if (!wired) {
		wired = true;
		client.on("sessionState", (payload) => {
			todoAgentMainDebug.info(
				"todo-daemon-bridge-session-state",
				getTodoSessionDebugData(payload.session),
				{
					captureMessage: true,
					fingerprint: ["todo.agent.main", "todo-daemon-bridge-session-state"],
				},
			);
			getTodoSessionStore().externalEmit(payload.session);
		});
		client.on("streamEvents", (payload) => {
			todoAgentMainDebug.info(
				"todo-daemon-bridge-stream-batch",
				getTodoStreamBatchDebugData(payload.sessionId, payload.events),
			);
			for (const event of payload.events) {
				if (
					event.kind !== "system_init" &&
					event.kind !== "error" &&
					event.kind !== "remote_control" &&
					event.kind !== "remote_control_error"
				) {
					continue;
				}
				todoAgentMainDebug.info(
					"todo-daemon-bridge-stream-event",
					{
						sessionId: payload.sessionId,
						...getTodoStreamEventDebugData(event),
					},
					{
						captureMessage: true,
						fingerprint: [
							"todo.agent.main",
							"todo-daemon-bridge-stream-event",
							event.kind,
						],
					},
				);
			}
			getTodoSessionStore().externalEmitStream(
				payload.sessionId,
				payload.events,
			);
		});
		client.on("disconnected", () => {
			console.warn(
				"[todo-agent] daemon disconnected — will reconnect on next RPC",
			);
			todoAgentMainDebug.warn(
				"todo-daemon-bridge-disconnected",
				undefined,
				{
					captureMessage: true,
					fingerprint: ["todo.agent.main", "todo-daemon-bridge-disconnected"],
				},
			);
		});
		client.on("error", (error) => {
			console.warn("[todo-agent] daemon client error", error);
			todoAgentMainDebug.captureException(
				error,
				"todo-daemon-bridge-error",
				undefined,
				{
					fingerprint: ["todo.agent.main", "todo-daemon-bridge-error"],
				},
			);
		});
	}
	connectPromise = (async () => {
		todoAgentMainDebug.info(
			"todo-daemon-bridge-init",
			undefined,
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-daemon-bridge-init"],
			},
		);
		try {
			await client.ensureConnected();
			await client.rehydrate();
			todoAgentMainDebug.info(
				"todo-daemon-bridge-init-success",
				undefined,
				{
					captureMessage: true,
					fingerprint: ["todo.agent.main", "todo-daemon-bridge-init-success"],
				},
			);
		} catch (error) {
			console.warn("[todo-agent] daemon bridge failed to initialize", error);
			todoAgentMainDebug.captureException(
				error,
				"todo-daemon-bridge-init-failed",
				undefined,
				{
					fingerprint: ["todo.agent.main", "todo-daemon-bridge-init-failed"],
				},
			);
			// Drop the cached promise so a later retry can try again.
			connectPromise = null;
			throw error;
		}
	})();
	return connectPromise;
}

export function stopTodoAgentDaemonBridge(): void {
	disposeTodoDaemonClient();
	connectPromise = null;
	wired = false;
}
