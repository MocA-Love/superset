import {
	disposeTodoDaemonClient,
	getTodoDaemonClient,
} from "main/lib/todo-daemon/client";
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
			getTodoSessionStore().externalEmit(payload.session);
		});
		client.on("streamEvents", (payload) => {
			getTodoSessionStore().externalEmitStream(
				payload.sessionId,
				payload.events,
			);
		});
		client.on("disconnected", () => {
			console.warn(
				"[todo-agent] daemon disconnected — will reconnect on next RPC",
			);
		});
		client.on("error", (error) => {
			console.warn("[todo-agent] daemon client error", error);
		});
	}
	connectPromise = (async () => {
		try {
			await client.ensureConnected();
			await client.rehydrate();
		} catch (error) {
			console.warn("[todo-agent] daemon bridge failed to initialize", error);
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
