/**
 * TODO Agent Daemon
 *
 * Standalone background process that owns `claude -p` child processes
 * for the autonomous TODO agent. Survives app restarts so users don't
 * lose in-flight sessions when they close the desktop app.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 electron dist/main/todo-daemon.js
 *
 * IPC:
 * - NDJSON over Unix domain socket at ~/.superset/todo-daemon.sock
 * - Auth token at ~/.superset/todo-daemon.token
 *
 * Issue: https://github.com/MocA-Love/superset/issues/237
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";
import {
	type AbortRequest,
	type HelloRequest,
	type HelloResponse,
	type IpcErrorResponse,
	type IpcEvent,
	type IpcRequest,
	type IpcSuccessResponse,
	type ListActiveResponse,
	type QueueInterventionRequest,
	type ResumeWaitingRequest,
	type SessionStateEventPayload,
	type SessionStreamEventPayload,
	type ShutdownRequest,
	type StartRequest,
	TODO_DAEMON_PROTOCOL_VERSION,
} from "../lib/todo-daemon/types";
import { getTodoSessionStore } from "../todo-agent/session-store";
import { invalidateTodoSettingsCache } from "../todo-agent/settings";
import type {
	TodoSessionStateEvent,
	TodoStreamUpdate,
} from "../todo-agent/types";
import { TodoSupervisorEngine } from "./supervisor-engine";

const DAEMON_VERSION = "1.0.0";
const SUPERSET_HOME_DIR = join(homedir(), SUPERSET_DIR_NAME);
const SOCKET_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.sock");
const TOKEN_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.token");
const PID_PATH = join(SUPERSET_HOME_DIR, "todo-daemon.pid");

// ============================================================================
// Logging
// ============================================================================

function log(
	level: "info" | "warn" | "error",
	message: string,
	data?: unknown,
): void {
	const timestamp = new Date().toISOString();
	const prefix = `[${timestamp}] [todo-daemon] [${level.toUpperCase()}]`;
	if (data !== undefined) {
		console.log(`${prefix} ${message}`, data);
	} else {
		console.log(`${prefix} ${message}`);
	}
}

// ============================================================================
// Auth
// ============================================================================

let authToken: string;

function ensureAuthToken(): string {
	if (existsSync(TOKEN_PATH)) {
		return readFileSync(TOKEN_PATH, "utf-8").trim();
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
	log("info", "Generated new auth token");
	return token;
}

function validateToken(token: string): boolean {
	return token === authToken;
}

// ============================================================================
// NDJSON
// ============================================================================

class NdjsonParser {
	private buffer = "";

	parse(chunk: string): IpcRequest[] {
		this.buffer += chunk;
		const messages: IpcRequest[] = [];
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.trim()) {
				try {
					messages.push(JSON.parse(line));
				} catch {
					log("warn", "Failed to parse NDJSON line");
				}
			}
			newlineIndex = this.buffer.indexOf("\n");
		}
		return messages;
	}
}

function sendResponse(
	socket: Socket,
	response: IpcSuccessResponse | IpcErrorResponse,
): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch (error) {
		log("warn", "Failed to write response", error);
	}
}

function sendSuccess(socket: Socket, id: string, payload: unknown): void {
	sendResponse(socket, { id, ok: true, payload });
}

function sendError(
	socket: Socket,
	id: string,
	code: string,
	message: string,
): void {
	sendResponse(socket, { id, ok: false, error: { code, message } });
}

// ============================================================================
// Event broadcasting
// ============================================================================

interface ClientState {
	authenticated: boolean;
}

const clients = new Set<Socket>();

function broadcastEvent(event: IpcEvent): void {
	const msg = `${JSON.stringify(event)}\n`;
	for (const socket of clients) {
		try {
			socket.write(msg);
		} catch {
			// best-effort
		}
	}
}

function broadcastSessionState(event: TodoSessionStateEvent): void {
	const payload: SessionStateEventPayload = { session: event.session };
	broadcastEvent({
		type: "event",
		event: "sessionState",
		payload,
	});
}

function broadcastStreamUpdate(update: TodoStreamUpdate): void {
	const payload: SessionStreamEventPayload = {
		sessionId: update.sessionId,
		events: update.events,
	};
	broadcastEvent({
		type: "event",
		event: "streamEvents",
		payload,
	});
}

// ============================================================================
// Engine + store wiring
// ============================================================================

let engine: TodoSupervisorEngine;

/**
 * Subscribed session IDs. The session-store uses a per-session
 * EventEmitter topic, so the bridge has to attach a listener for each
 * session it wants to forward. `listenSession` is idempotent.
 */
const subscribedSessionIds = new Set<string>();

function listenSession(sessionId: string): void {
	if (subscribedSessionIds.has(sessionId)) return;
	subscribedSessionIds.add(sessionId);
	const store = getTodoSessionStore();
	store.subscribe(sessionId, (event) => broadcastSessionState(event));
	store.subscribeStream(sessionId, (update) => broadcastStreamUpdate(update));
}

function wireStoreBridge(): void {
	// Attach listeners to every session currently in the DB so rehydrate
	// and daemon-restart emits reach whatever client is connected. The
	// `listAll` snapshot is one SQL query — cheap even for power users.
	for (const row of getTodoSessionStore().listAll()) {
		listenSession(row.id);
	}
}

// ============================================================================
// Request handlers
// ============================================================================

type Handler = (
	socket: Socket,
	id: string,
	payload: unknown,
	clientState: ClientState,
) => void | Promise<void>;

const handlers: Record<string, Handler> = {
	hello: (socket, id, payload, clientState) => {
		const request = payload as HelloRequest;
		if (request.protocolVersion !== TODO_DAEMON_PROTOCOL_VERSION) {
			sendError(
				socket,
				id,
				"PROTOCOL_MISMATCH",
				`Protocol version mismatch. Expected ${TODO_DAEMON_PROTOCOL_VERSION}, got ${request.protocolVersion}`,
			);
			return;
		}
		if (!validateToken(request.token)) {
			sendError(socket, id, "AUTH_FAILED", "Invalid auth token");
			return;
		}
		clientState.authenticated = true;
		const response: HelloResponse = {
			protocolVersion: TODO_DAEMON_PROTOCOL_VERSION,
			daemonVersion: DAEMON_VERSION,
			daemonPid: process.pid,
			activeSessionIds: engine.listActiveSessionIds(),
		};
		sendSuccess(socket, id, response);
	},
	start: async (socket, id, payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const request = payload as StartRequest;
		try {
			listenSession(request.sessionId);
			await engine.start(request.sessionId);
			sendSuccess(socket, id, { success: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			sendError(socket, id, "START_FAILED", msg);
		}
	},
	abort: (socket, id, payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const request = payload as AbortRequest;
		try {
			listenSession(request.sessionId);
			engine.abort(request.sessionId);
			sendSuccess(socket, id, { success: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			sendError(socket, id, "ABORT_FAILED", msg);
		}
	},
	queueIntervention: (socket, id, payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const request = payload as QueueInterventionRequest;
		try {
			listenSession(request.sessionId);
			engine.queueIntervention(request.sessionId, request.data);
			sendSuccess(socket, id, { success: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			sendError(socket, id, "INTERVENTION_FAILED", msg);
		}
	},
	resumeWaiting: async (socket, id, payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const request = payload as ResumeWaitingRequest;
		try {
			for (const sid of request.sessionIds) {
				listenSession(sid);
				await engine.start(sid);
			}
			sendSuccess(socket, id, { success: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			sendError(socket, id, "RESUME_FAILED", msg);
		}
	},
	settingsChanged: (socket, id, _payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		invalidateTodoSettingsCache();
		engine.handleSettingsChanged();
		sendSuccess(socket, id, { success: true });
	},
	rehydrate: (socket, id, _payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const store = getTodoSessionStore();
		const rows = store.listAll();
		for (const row of rows) {
			listenSession(row.id);
		}
		const n = store.rehydrateStrandedSessionsExcept(
			engine.listActiveSessionIds(),
		);
		log("info", `Rehydrated ${n} stranded session(s) on client request`);
		sendSuccess(socket, id, { success: true });
	},
	listActive: (socket, id, _payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const response: ListActiveResponse = {
			sessionIds: engine.listActiveSessionIds(),
		};
		sendSuccess(socket, id, response);
	},
	shutdown: (socket, id, payload, clientState) => {
		if (!clientState.authenticated) {
			sendError(socket, id, "NOT_AUTHENTICATED", "Authenticate first");
			return;
		}
		const request = payload as ShutdownRequest;
		log("info", "Shutdown requested", request);
		sendSuccess(socket, id, { success: true });
		setTimeout(() => {
			engine.shutdownAll({ killChildren: !!request.killSessions });
			void stopServer().then(() => process.exit(0));
		}, 100);
	},
};

async function handleRequest(
	socket: Socket,
	request: IpcRequest,
	clientState: ClientState,
): Promise<void> {
	const handler = handlers[request.type];
	if (!handler) {
		sendError(
			socket,
			request.id,
			"UNKNOWN_REQUEST",
			`Unknown request type: ${request.type}`,
		);
		return;
	}
	try {
		await handler(socket, request.id, request.payload, clientState);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		sendError(socket, request.id, "INTERNAL_ERROR", msg);
		log("error", `Handler error for ${request.type}`, msg);
	}
}

// ============================================================================
// Server
// ============================================================================

let server: Server | null = null;

function handleConnection(socket: Socket): void {
	const parser = new NdjsonParser();
	const clientState: ClientState = { authenticated: false };
	clients.add(socket);
	socket.setEncoding("utf-8");

	socket.on("data", (data: string) => {
		const messages = parser.parse(data);
		for (const message of messages) {
			handleRequest(socket, message, clientState).catch((error) => {
				log(
					"error",
					"Unhandled request error",
					error instanceof Error ? error.message : String(error),
				);
			});
		}
	});

	socket.on("close", () => {
		clients.delete(socket);
	});

	socket.on("error", (error) => {
		log("warn", `Socket error`, error.message);
		clients.delete(socket);
	});
}

function isSocketLive(): Promise<boolean> {
	return new Promise((resolve) => {
		if (!existsSync(SOCKET_PATH)) {
			resolve(false);
			return;
		}
		const probe = new Socket();
		const timeout = setTimeout(() => {
			probe.destroy();
			resolve(false);
		}, 1_000);
		probe.on("connect", () => {
			clearTimeout(timeout);
			probe.destroy();
			resolve(true);
		});
		probe.on("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
		probe.connect(SOCKET_PATH);
	});
}

async function startServer(): Promise<void> {
	if (!existsSync(SUPERSET_HOME_DIR)) {
		mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
	}
	try {
		chmodSync(SUPERSET_HOME_DIR, 0o700);
	} catch {
		// may fail if not owner
	}

	if (existsSync(SOCKET_PATH)) {
		const live = await isSocketLive();
		if (live) {
			log("error", "Another daemon is already running");
			throw new Error("Another daemon is already running");
		}
		try {
			unlinkSync(SOCKET_PATH);
		} catch (error) {
			throw new Error(`Failed to remove stale socket: ${error}`);
		}
	}
	if (existsSync(PID_PATH)) {
		try {
			unlinkSync(PID_PATH);
		} catch {
			// ignore
		}
	}

	authToken = ensureAuthToken();
	engine = new TodoSupervisorEngine();
	wireStoreBridge();

	// Mark any sessions the previous daemon left mid-run as failed.
	getTodoSessionStore().rehydrateStrandedSessionsExcept(
		engine.listActiveSessionIds(),
	);

	const newServer = createServer(handleConnection);
	server = newServer;
	await new Promise<void>((resolve, reject) => {
		newServer.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") {
				log("error", "Socket already in use");
				reject(new Error("Socket already in use"));
			} else {
				log("error", "Server error", error.message);
				reject(error);
			}
		});
		newServer.listen(SOCKET_PATH, () => {
			try {
				chmodSync(SOCKET_PATH, 0o600);
			} catch {
				// ignore
			}
			writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
			log("info", `Daemon started on ${SOCKET_PATH}, PID=${process.pid}`);
			resolve();
		});
	});
}

async function stopServer(): Promise<void> {
	for (const socket of clients) {
		try {
			socket.destroy();
		} catch {
			// ignore
		}
	}
	clients.clear();
	await new Promise<void>((resolve) => {
		if (server) {
			server.close(() => resolve());
		} else {
			resolve();
		}
	});
	try {
		if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
		if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
	} catch {
		// best-effort
	}
}

// ============================================================================
// Signal handling
// ============================================================================

function setupSignalHandlers(): void {
	const onSignal = (sig: string) => {
		log("info", `Received ${sig}, shutting down`);
		if (engine) engine.shutdownAll({ killChildren: true });
		void stopServer().then(() => process.exit(0));
	};
	process.on("SIGTERM", () => onSignal("SIGTERM"));
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGHUP", () => onSignal("SIGHUP"));
	process.on("uncaughtException", (error) => {
		log("error", "Uncaught exception", error);
	});
	process.on("unhandledRejection", (reason) => {
		log("error", "Unhandled rejection", reason);
	});
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	log("info", "TODO Agent daemon starting…");
	log("info", `Environment: ${process.env.NODE_ENV || "production"}`);
	setupSignalHandlers();
	try {
		await startServer();
	} catch (error) {
		log(
			"error",
			"Failed to start",
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	}
}

void main();
