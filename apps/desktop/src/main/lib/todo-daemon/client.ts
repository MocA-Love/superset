/**
 * TODO Agent Daemon Client
 *
 * Client library for the Electron main process to communicate with
 * the todo-agent daemon. Mirrors the pattern used by terminal-host/client.ts
 * but scoped to the smaller TODO-agent protocol.
 *
 * The daemon owns `claude -p` child processes so TODO sessions survive
 * app restarts — see issue #237.
 */

import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { todoAgentMainDebug } from "main/todo-agent/debug";
import { SUPERSET_DIR_NAME } from "shared/constants";
import { spawnPersistent } from "../process-persistence";
import {
	type AbortRequest,
	type EmptyResponse,
	type HelloResponse,
	type IpcEvent,
	type IpcResponse,
	type ListActiveResponse,
	type QueueInterventionRequest,
	type ResumeWaitingRequest,
	type SessionStateEventPayload,
	type SessionStreamEventPayload,
	type ShutdownRequest,
	type StartRequest,
	TODO_DAEMON_PROTOCOL_VERSION,
} from "./types";

const DEBUG = process.env.SUPERSET_TODO_DAEMON_DEBUG === "1";

const SUPERSET_HOME_DIR = join(homedir(), SUPERSET_DIR_NAME);
const SOCKET_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.sock");
const TOKEN_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.token");
const PID_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.pid");
const SPAWN_LOCK_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.spawn.lock");
const SCRIPT_MTIME_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.mtime");

const CONNECT_TIMEOUT_MS = 5_000;
const SPAWN_WAIT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SPAWN_LOCK_TIMEOUT_MS = 10_000;
const MAX_DAEMON_LOG_BYTES = 5 * 1024 * 1024;

function log(level: "info" | "warn" | "error", message: string): void {
	if (!DEBUG && level === "info") return;
	const prefix = `[todo-daemon-client]`;
	if (level === "error") {
		console.error(`${prefix} ${message}`);
	} else if (level === "warn") {
		console.warn(`${prefix} ${message}`);
	} else {
		console.log(`${prefix} ${message}`);
	}
}

class NdjsonParser {
	private remainder = "";

	parse(chunk: string): Array<IpcResponse | IpcEvent> {
		const messages: Array<IpcResponse | IpcEvent> = [];
		const data = this.remainder + chunk;
		this.remainder = "";

		let startIndex = 0;
		let newlineIndex = data.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = data.slice(startIndex, newlineIndex);
			if (line.trim()) {
				try {
					messages.push(JSON.parse(line));
				} catch {
					log("warn", "Failed to parse NDJSON line");
				}
			}
			startIndex = newlineIndex + 1;
			newlineIndex = data.indexOf("\n", startIndex);
		}
		if (startIndex < data.length) {
			this.remainder = data.slice(startIndex);
		}
		return messages;
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
}

export interface TodoDaemonClientEvents {
	sessionState: (payload: SessionStateEventPayload) => void;
	streamEvents: (payload: SessionStreamEventPayload) => void;
	connected: () => void;
	disconnected: () => void;
	error: (error: Error) => void;
}

enum ConnectionState {
	DISCONNECTED = "disconnected",
	CONNECTING = "connecting",
	CONNECTED = "connected",
}

export class TodoDaemonClient extends EventEmitter {
	private socket: Socket | null = null;
	private parser = new NdjsonParser();
	private pendingRequests = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private authenticated = false;
	private connectionState = ConnectionState.DISCONNECTED;
	private disposed = false;
	private disconnectArmed = false;
	private activeSessionIds: string[] = [];

	async ensureConnected(): Promise<void> {
		if (
			this.connectionState === ConnectionState.CONNECTED &&
			this.socket &&
			this.authenticated
		) {
			return;
		}
		if (this.connectionState === ConnectionState.CONNECTING) {
			return this.waitForConnection();
		}
		this.connectionState = ConnectionState.CONNECTING;
		this.disconnectArmed = false;
		try {
			await this.connectAndAuthenticate();
			this.connectionState = ConnectionState.CONNECTED;
			this.emit("connected");
		} catch (error) {
			this.resetConnectionState({ emitDisconnected: false });
			throw error;
		}
	}

	/** Sessions the daemon reported as in-flight at last hello. */
	getKnownActiveSessionIds(): readonly string[] {
		return this.activeSessionIds;
	}

	private async waitForConnection(): Promise<void> {
		const start = Date.now();
		while (this.connectionState === ConnectionState.CONNECTING) {
			if (Date.now() - start > 10_000) {
				throw new Error("Timed out waiting for daemon connection");
			}
			await this.sleep(100);
		}
		if (
			this.connectionState !== ConnectionState.CONNECTED ||
			!this.authenticated
		) {
			throw new Error("Connection attempt failed");
		}
	}

	private async connectAndAuthenticate(): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (
				attempt === 0 &&
				process.env.NODE_ENV === "development" &&
				this.isDaemonScriptStale()
			) {
				log("info", "Daemon script rebuilt, restarting...");
				this.killDaemonFromPidFile();
				await this.waitForDaemonShutdown();
			}

			let connected = await this.tryConnect();
			if (!connected) {
				await this.spawnDaemon();
				connected = await this.tryConnect();
				if (!connected) {
					throw new Error("Failed to connect to daemon after spawn");
				}
			}

			const token = this.readAuthToken();
			try {
				const response = await this.sendRequest<HelloResponse>("hello", {
					protocolVersion: TODO_DAEMON_PROTOCOL_VERSION,
					token,
				});
				if (response.protocolVersion !== TODO_DAEMON_PROTOCOL_VERSION) {
					if (attempt === 0) {
						log(
							"info",
							`Protocol mismatch (client=${TODO_DAEMON_PROTOCOL_VERSION}, daemon=${response.protocolVersion}), restarting daemon`,
						);
						this.killDaemonFromPidFile();
						await this.waitForDaemonShutdown();
						this.resetConnectionState({ emitDisconnected: false });
						continue;
					}
					throw new Error(
						`Protocol version mismatch: client=${TODO_DAEMON_PROTOCOL_VERSION}, daemon=${response.protocolVersion}`,
					);
				}
				this.authenticated = true;
				this.activeSessionIds = Array.isArray(response.activeSessionIds)
					? response.activeSessionIds.slice()
					: [];
				todoAgentMainDebug.info(
					"todo-daemon-client-authenticated",
					{
						protocolVersion: response.protocolVersion,
						activeSessionCount: this.activeSessionIds.length,
					},
					{
						captureMessage: true,
						fingerprint: [
							"todo.agent.main",
							"todo-daemon-client-authenticated",
						],
					},
				);
				return;
			} catch (error) {
				if (attempt === 0) {
					log(
						"warn",
						`hello failed (${
							error instanceof Error ? error.message : String(error)
						}), retrying with a fresh daemon`,
					);
					this.killDaemonFromPidFile();
					await this.waitForDaemonShutdown();
					this.resetConnectionState({ emitDisconnected: false });
					continue;
				}
				throw error;
			}
		}
		throw new Error("Exhausted connection retries");
	}

	private async tryConnect(): Promise<boolean> {
		return new Promise((resolve) => {
			if (!existsSync(SOCKET_PATH)) {
				resolve(false);
				return;
			}
			try {
				this.socket?.destroy();
			} catch {
				// ignore
			}
			this.socket = null;
			this.authenticated = false;

			const socket = connect(SOCKET_PATH);
			let resolved = false;
			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					socket.destroy();
					resolve(false);
				}
			}, CONNECT_TIMEOUT_MS);
			socket.on("connect", () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeout);
				socket.setEncoding("utf8");
				socket.unref();
				this.socket = socket;
				this.setupSocketHandlers();
				resolve(true);
			});
			socket.on("error", () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeout);
				resolve(false);
			});
		});
	}

	private setupSocketHandlers(): void {
		const socket = this.socket;
		if (!socket) return;
		socket.on("data", (data: string) => {
			const messages = this.parser.parse(data);
			for (const message of messages) {
				this.handleMessage(message);
			}
		});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.handleDisconnect();
		});
		socket.on("error", (error) => {
			if (this.socket !== socket) return;
			this.emit("error", error);
			this.handleDisconnect();
		});
	}

	private handleMessage(message: IpcResponse | IpcEvent): void {
		if ("id" in message) {
			const pending = this.pendingRequests.get(message.id);
			if (!pending) return;
			this.pendingRequests.delete(message.id);
			clearTimeout(pending.timeoutId);
			if (message.ok) {
				pending.resolve(message.payload);
			} else {
				pending.reject(
					new Error(`${message.error.code}: ${message.error.message}`),
				);
			}
			return;
		}
		if (message.type === "event") {
			switch (message.event) {
				case "sessionState":
					this.emit(
						"sessionState",
						message.payload as SessionStateEventPayload,
					);
					return;
				case "streamEvents":
					this.emit(
						"streamEvents",
						message.payload as SessionStreamEventPayload,
					);
					return;
				default:
					log("warn", `Unknown event: ${message.event}`);
			}
		}
	}

	private handleDisconnect(): void {
		if (this.disconnectArmed) return;
		this.disconnectArmed = true;
		this.resetConnectionState({ emitDisconnected: true });
	}

	private resetConnectionState({
		emitDisconnected,
	}: {
		emitDisconnected: boolean;
	}): void {
		try {
			this.socket?.destroy();
		} catch {
			// ignore
		}
		this.socket = null;
		this.authenticated = false;
		this.connectionState = ConnectionState.DISCONNECTED;
		this.parser = new NdjsonParser();
		for (const [id, pending] of this.pendingRequests.entries()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error("Connection lost"));
			this.pendingRequests.delete(id);
		}
		if (emitDisconnected) {
			this.emit("disconnected");
		}
	}

	private readAuthToken(): string {
		if (!existsSync(TOKEN_PATH)) {
			throw new Error("Auth token not found — daemon may not be running");
		}
		return readFileSync(TOKEN_PATH, "utf-8").trim();
	}

	private ensureAuthToken(): string {
		if (existsSync(TOKEN_PATH)) {
			try {
				return readFileSync(TOKEN_PATH, "utf-8").trim();
			} catch {
				// fall through and regenerate
			}
		}
		if (!existsSync(SUPERSET_HOME_DIR)) {
			mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
		}
		const token = randomBytes(32).toString("hex");
		writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
		return token;
	}

	private killDaemonFromPidFile(): void {
		if (!existsSync(PID_PATH)) return;
		try {
			const raw = readFileSync(PID_PATH, "utf-8").trim();
			const pid = Number.parseInt(raw, 10);
			if (!Number.isNaN(pid)) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// stale pid
				}
			}
		} catch {
			// best effort
		}
	}

	private async waitForDaemonShutdown(): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < 3_000) {
			if (!existsSync(SOCKET_PATH)) return;
			await this.sleep(100);
		}
	}

	private acquireSpawnLock(): boolean {
		try {
			if (!existsSync(SUPERSET_HOME_DIR)) {
				mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
			}
			try {
				chmodSync(SUPERSET_HOME_DIR, 0o700);
			} catch {
				// best effort
			}
			if (existsSync(SPAWN_LOCK_PATH)) {
				const lockContent = readFileSync(SPAWN_LOCK_PATH, "utf-8").trim();
				const lockTime = Number.parseInt(lockContent, 10);
				if (
					!Number.isNaN(lockTime) &&
					Date.now() - lockTime < SPAWN_LOCK_TIMEOUT_MS
				) {
					return false;
				}
				unlinkSync(SPAWN_LOCK_PATH);
			}
			writeFileSync(SPAWN_LOCK_PATH, String(Date.now()), { mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}

	private releaseSpawnLock(): void {
		try {
			if (existsSync(SPAWN_LOCK_PATH)) unlinkSync(SPAWN_LOCK_PATH);
		} catch {
			// ignore
		}
	}

	private isDaemonScriptStale(): boolean {
		try {
			if (!existsSync(SCRIPT_MTIME_PATH)) return false;
			const savedMtime = readFileSync(SCRIPT_MTIME_PATH, "utf-8").trim();
			const scriptPath = this.getDaemonScriptPath();
			if (!existsSync(scriptPath)) return false;
			const currentMtime = statSync(scriptPath).mtimeMs.toString();
			return savedMtime !== currentMtime;
		} catch {
			return false;
		}
	}

	private saveDaemonScriptMtime(): void {
		try {
			const scriptPath = this.getDaemonScriptPath();
			if (!existsSync(scriptPath)) return;
			const mtime = statSync(scriptPath).mtimeMs.toString();
			writeFileSync(SCRIPT_MTIME_PATH, mtime, { mode: 0o600 });
		} catch {
			// best effort
		}
	}

	private getDaemonScriptPath(): string {
		const appPath = app.getAppPath();
		return join(appPath, "dist", "main", "todo-daemon.js");
	}

	private async spawnDaemon(): Promise<void> {
		if (existsSync(SOCKET_PATH)) {
			const live = await this.isSocketLive();
			if (live) {
				log("info", "Socket is live, daemon already running");
				return;
			}
			try {
				unlinkSync(SOCKET_PATH);
			} catch {
				// ignore
			}
		}
		if (existsSync(PID_PATH)) {
			try {
				unlinkSync(PID_PATH);
			} catch {
				// ignore
			}
		}

		if (!this.acquireSpawnLock()) {
			log("info", "Another spawn in progress, waiting...");
			await this.waitForDaemon();
			return;
		}
		try {
			this.ensureAuthToken();

			const daemonScript = this.getDaemonScriptPath();
			if (!existsSync(daemonScript)) {
				throw new Error(`Daemon script not found: ${daemonScript}`);
			}

			const logPath = join(SUPERSET_HOME_DIR, "todo-daemon.log");
			let logFd: number;
			try {
				if (existsSync(logPath)) {
					try {
						const { size } = statSync(logPath);
						if (size > MAX_DAEMON_LOG_BYTES) {
							writeFileSync(logPath, "", { mode: 0o600 });
						}
					} catch {
						// best effort
					}
				}
				logFd = openSync(logPath, "a", 0o600);
				try {
					chmodSync(logPath, 0o600);
				} catch {
					// best effort
				}
			} catch (error) {
				log("warn", `Failed to open daemon log: ${error}`);
				logFd = -1;
			}

			// On Linux, spawnPersistent wraps with `systemd-run --user --scope`
			// so the daemon survives Electron's systemd-logind app scope
			// terminating on quit. We don't use the returned `scopeUnit` —
			// todo-daemon is stopped via IPC, not signals.
			let child: ChildProcess | null = null;
			try {
				child = spawnPersistent(
					process.execPath,
					[daemonScript],
					{
						detached: true,
						stdio: logFd >= 0 ? ["ignore", logFd, logFd] : "ignore",
						env: {
							...process.env,
							ELECTRON_RUN_AS_NODE: "1",
							NODE_ENV: process.env.NODE_ENV,
						},
					},
					{ unitLabel: "superset-todo-daemon" },
				).child;
			} finally {
				if (logFd >= 0) {
					try {
						closeSync(logFd);
					} catch {
						// ignore
					}
				}
			}

			if (!child) {
				throw new Error("Failed to spawn daemon");
			}
			log("info", `Daemon spawned PID=${child.pid}`);
			child.unref();

			await this.waitForDaemon();
			if (process.env.NODE_ENV === "development") {
				this.saveDaemonScriptMtime();
			}
		} finally {
			this.releaseSpawnLock();
		}
	}

	private async waitForDaemon(): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < SPAWN_WAIT_MS) {
			if (existsSync(SOCKET_PATH)) {
				await this.sleep(150);
				return;
			}
			await this.sleep(100);
		}
		throw new Error("Daemon failed to start in time");
	}

	private isSocketLive(): Promise<boolean> {
		return new Promise((resolve) => {
			if (!existsSync(SOCKET_PATH)) {
				resolve(false);
				return;
			}
			const testSocket = connect(SOCKET_PATH);
			const timeout = setTimeout(() => {
				testSocket.destroy();
				resolve(false);
			}, 1_000);
			testSocket.on("connect", () => {
				clearTimeout(timeout);
				testSocket.destroy();
				resolve(true);
			});
			testSocket.on("error", () => {
				clearTimeout(timeout);
				resolve(false);
			});
		});
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private sendRequest<T>(type: string, payload: unknown): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this.socket) {
				reject(new Error("Not connected"));
				return;
			}
			const id = `req_${++this.requestCounter}_${randomUUID().slice(0, 8)}`;
			const timeoutId = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timeout: ${type}`));
			}, REQUEST_TIMEOUT_MS);
			this.pendingRequests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeoutId,
			});
			const message = `${JSON.stringify({ id, type, payload })}\n`;
			this.socket.write(message);
		});
	}

	// =========================================================================
	// Public API
	// =========================================================================

	async start(request: StartRequest): Promise<EmptyResponse> {
		todoAgentMainDebug.info(
			"todo-daemon-client-start-request",
			{
				sessionId: request.sessionId,
				fromScheduledWakeup: request.fromScheduledWakeup ?? false,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-daemon-client-start-request"],
			},
		);
		try {
			await this.ensureConnected();
			const response = await this.sendRequest<EmptyResponse>("start", request);
			todoAgentMainDebug.info(
				"todo-daemon-client-start-request-success",
				{
					sessionId: request.sessionId,
					fromScheduledWakeup: request.fromScheduledWakeup ?? false,
				},
				{
					captureMessage: true,
					fingerprint: [
						"todo.agent.main",
						"todo-daemon-client-start-request-success",
					],
				},
			);
			return response;
		} catch (error) {
			todoAgentMainDebug.captureException(
				error,
				"todo-daemon-client-start-request-failed",
				{
					sessionId: request.sessionId,
					fromScheduledWakeup: request.fromScheduledWakeup ?? false,
				},
				{
					fingerprint: [
						"todo.agent.main",
						"todo-daemon-client-start-request-failed",
					],
				},
			);
			throw error;
		}
	}

	async abort(request: AbortRequest): Promise<EmptyResponse> {
		await this.ensureConnected();
		return this.sendRequest<EmptyResponse>("abort", request);
	}

	async queueIntervention(
		request: QueueInterventionRequest,
	): Promise<EmptyResponse> {
		await this.ensureConnected();
		return this.sendRequest<EmptyResponse>("queueIntervention", request);
	}

	async resumeWaiting(request: ResumeWaitingRequest): Promise<EmptyResponse> {
		await this.ensureConnected();
		return this.sendRequest<EmptyResponse>("resumeWaiting", request);
	}

	async settingsChanged(): Promise<EmptyResponse> {
		await this.ensureConnected();
		return this.sendRequest<EmptyResponse>("settingsChanged", {});
	}

	async rehydrate(): Promise<EmptyResponse> {
		try {
			await this.ensureConnected();
			const response = await this.sendRequest<EmptyResponse>("rehydrate", {});
			todoAgentMainDebug.info(
				"todo-daemon-client-rehydrate-success",
				{
					activeSessionCount: this.activeSessionIds.length,
				},
				{
					captureMessage: true,
					fingerprint: [
						"todo.agent.main",
						"todo-daemon-client-rehydrate-success",
					],
				},
			);
			return response;
		} catch (error) {
			todoAgentMainDebug.captureException(
				error,
				"todo-daemon-client-rehydrate-failed",
				undefined,
				{
					fingerprint: [
						"todo.agent.main",
						"todo-daemon-client-rehydrate-failed",
					],
				},
			);
			throw error;
		}
	}

	async listActive(): Promise<ListActiveResponse> {
		await this.ensureConnected();
		return this.sendRequest<ListActiveResponse>("listActive", undefined);
	}

	async shutdown(request: ShutdownRequest = {}): Promise<EmptyResponse> {
		await this.ensureConnected();
		const response = await this.sendRequest<EmptyResponse>("shutdown", request);
		this.disconnect();
		return response;
	}

	disconnect(): void {
		this.disconnectArmed = true;
		this.resetConnectionState({ emitDisconnected: false });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.disconnect();
		this.removeAllListeners();
	}
}

let clientInstance: TodoDaemonClient | null = null;

export function getTodoDaemonClient(): TodoDaemonClient {
	if (!clientInstance) {
		clientInstance = new TodoDaemonClient();
	}
	return clientInstance;
}

export function disposeTodoDaemonClient(): void {
	if (clientInstance) {
		clientInstance.dispose();
		clientInstance = null;
	}
}
