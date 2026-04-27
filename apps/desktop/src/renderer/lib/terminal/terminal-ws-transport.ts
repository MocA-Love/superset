import type { Terminal as XTerm } from "@xterm/xterm";
import {
	logTerminalInput,
	logTerminalWrite,
	terminalRendererDebug,
} from "./debug";

export type ConnectionState = "disconnected" | "connecting" | "open" | "closed";

type TerminalServerMessage =
	| { type: "data"; data: string }
	| { type: "error"; message: string }
	| { type: "exit"; exitCode: number; signal: number }
	| { type: "replay"; data: string }
	| { type: "title"; title: string | null };

export interface TerminalTransport {
	debugId: string | null;
	socket: WebSocket | null;
	connectionState: ConnectionState;
	/** The URL the socket is currently connected (or connecting) to. */
	currentUrl: string | null;
	title: string | null | undefined;
	onDataDisposable: { dispose(): void } | null;
	stateListeners: Set<() => void>;
	titleListeners: Set<() => void>;
	/** Internal: auto-reconnect timer. */
	_reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** Internal: reconnect attempt count for backoff. */
	_reconnectAttempt: number;
	/** The xterm instance used for reconnection. */
	_terminal: XTerm | null;
	/** Set when the server sends an exit message — no reconnect after this. */
	_exited: boolean;
}

function setConnectionState(
	transport: TerminalTransport,
	state: ConnectionState,
) {
	transport.connectionState = state;
	for (const listener of transport.stateListeners) {
		listener();
	}
}

function setTerminalTitle(
	transport: TerminalTransport,
	title: string | null | undefined,
) {
	if (transport.title === title) return;
	transport.title = title;
	for (const listener of transport.titleListeners) {
		listener();
	}
}

const MAX_RECONNECT_DELAY = 10_000;
const BASE_RECONNECT_DELAY = 500;
const MAX_RECONNECT_ATTEMPTS = 10;

export function createTransport(debugId?: string): TerminalTransport {
	return {
		debugId: debugId ?? null,
		socket: null,
		connectionState: "disconnected",
		currentUrl: null,
		title: undefined,
		onDataDisposable: null,
		stateListeners: new Set(),
		titleListeners: new Set(),
		_reconnectTimer: null,
		_reconnectAttempt: 0,
		_terminal: null,
		_exited: false,
	};
}

function scheduleReconnect(transport: TerminalTransport) {
	if (transport._reconnectTimer) return;
	if (transport._exited) return;
	if (!transport.currentUrl || !transport._terminal) return;
	if (transport._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;

	const delay = Math.min(
		BASE_RECONNECT_DELAY * 2 ** transport._reconnectAttempt,
		MAX_RECONNECT_DELAY,
	);
	transport._reconnectAttempt++;
	terminalRendererDebug.info(
		"ws-reconnect-scheduled",
		{
			terminalId: transport.debugId,
			delayMs: delay,
			reconnectAttempt: transport._reconnectAttempt,
		},
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "ws-reconnect-scheduled"],
		},
	);

	transport._reconnectTimer = setTimeout(() => {
		transport._reconnectTimer = null;
		if (
			transport.connectionState === "closed" &&
			transport.currentUrl &&
			transport._terminal
		) {
			connect(transport, transport._terminal, transport.currentUrl);
		}
	}, delay);
}

function cancelReconnect(transport: TerminalTransport) {
	if (transport._reconnectTimer) {
		clearTimeout(transport._reconnectTimer);
		transport._reconnectTimer = null;
	}
}

function formatWsEndpoint(wsUrl: string | null): string {
	if (!wsUrl) return "unknown endpoint";
	try {
		const url = new URL(wsUrl);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "invalid terminal WebSocket URL";
	}
}

function formatCloseDetails(event: CloseEvent): string {
	const code = event.code || "unknown";
	const reason = event.reason ? `, reason: ${event.reason}` : "";
	return `code: ${code}${reason}`;
}

export function connect(
	transport: TerminalTransport,
	terminal: XTerm,
	wsUrl: string,
) {
	// Idempotent: skip if already connected/connecting to the same endpoint.
	const isActive =
		transport.connectionState === "open" ||
		transport.connectionState === "connecting";
	if (isActive && transport.currentUrl === wsUrl) return;

	if (transport.socket) {
		transport.socket.close();
		transport.socket = null;
	}

	cancelReconnect(transport);
	transport.currentUrl = wsUrl;
	transport._terminal = terminal;
	transport._exited = false;
	terminalRendererDebug.info(
		"ws-connect-start",
		{
			terminalId: transport.debugId,
			wsUrl,
			reconnectAttempt: transport._reconnectAttempt,
		},
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "ws-connect-start"],
		},
	);
	setConnectionState(transport, "connecting");
	const socket = new WebSocket(wsUrl);
	transport.socket = socket;

	socket.addEventListener("open", () => {
		if (transport.socket !== socket) return;
		transport._reconnectAttempt = 0;
		terminalRendererDebug.info(
			"ws-open",
			{ terminalId: transport.debugId },
			{
				captureMessage: true,
				fingerprint: ["terminal.renderer", "ws-open"],
			},
		);
		setConnectionState(transport, "open");
		sendResize(transport, terminal.cols, terminal.rows);
	});

	socket.addEventListener("message", (event) => {
		if (transport.socket !== socket) return;
		let message: TerminalServerMessage;
		try {
			message = JSON.parse(String(event.data)) as TerminalServerMessage;
		} catch {
			terminalRendererDebug.error(
				"ws-invalid-payload",
				{ terminalId: transport.debugId },
				{
					captureMessage: true,
					fingerprint: ["terminal.renderer", "ws-invalid-payload"],
				},
			);
			terminal.writeln("\r\n[terminal] invalid server payload");
			return;
		}

		if (message.type === "data" || message.type === "replay") {
			terminalRendererDebug.increment("ws-receive-events", 1, {
				data: { terminalId: transport.debugId, type: message.type },
			});
			terminalRendererDebug.observe("ws-receive-bytes", message.data.length, {
				data: { terminalId: transport.debugId, type: message.type },
			});
			logTerminalWrite("ws-message", message.data.length, {
				terminalId: transport.debugId,
				messageType: message.type,
			});
			terminal.write(message.data);
			return;
		}

		if (message.type === "title") {
			setTerminalTitle(transport, message.title);
			return;
		}

		if (message.type === "error") {
			terminalRendererDebug.warn(
				"ws-server-error",
				{
					terminalId: transport.debugId,
					errorMessage: message.message,
				},
				{
					captureMessage: true,
					fingerprint: ["terminal.renderer", "ws-server-error"],
				},
			);
			terminal.writeln(`\r\n[terminal] ${message.message}`);
			return;
		}

		if (message.type === "exit") {
			transport._exited = true;
			cancelReconnect(transport);
			terminalRendererDebug.info(
				"ws-exit",
				{
					terminalId: transport.debugId,
					exitCode: message.exitCode,
					signal: message.signal,
				},
				{
					captureMessage: true,
					fingerprint: ["terminal.renderer", "ws-exit"],
				},
			);
			terminal.writeln(
				`\r\n[terminal] exited with code ${message.exitCode} (signal ${message.signal})`,
			);
		}
	});

	socket.addEventListener("close", (event) => {
		if (transport.socket !== socket) return;
		terminalRendererDebug.warn(
			"ws-close",
			{
				terminalId: transport.debugId,
				exited: transport._exited,
				reconnectAttempt: transport._reconnectAttempt,
			},
			{
				captureMessage: true,
				fingerprint: ["terminal.renderer", "ws-close"],
			},
		);
		setConnectionState(transport, "closed");
		transport.socket = null;
		if (!transport._exited && event.code !== 1000) {
			const willReconnect =
				!transport._reconnectTimer &&
				Boolean(transport.currentUrl && transport._terminal) &&
				transport._reconnectAttempt < MAX_RECONNECT_ATTEMPTS;
			terminal.writeln(
				`\r\n[terminal] WebSocket closed while connected to ${formatWsEndpoint(transport.currentUrl)} (${formatCloseDetails(event)}). ${willReconnect ? "Reconnecting..." : "Max reconnect attempts reached."}`,
			);
		}
		// Auto-reconnect on unexpected close (host-service restart, network blip)
		scheduleReconnect(transport);
	});

	socket.addEventListener("error", () => {
		if (transport.socket !== socket) return;
		// FORK NOTE: keep Sentry debug capture (terminalRendererDebug.error)
		// alongside upstream's user-facing detailed diagnostic message.
		terminalRendererDebug.error(
			"ws-error",
			{ terminalId: transport.debugId },
			{
				captureMessage: true,
				fingerprint: ["terminal.renderer", "ws-error"],
			},
		);
		terminal.writeln(
			`\r\n[terminal] WebSocket error while connecting to ${formatWsEndpoint(transport.currentUrl)}. Check host-service or relay connectivity.`,
		);
	});

	transport.onDataDisposable?.dispose();
	transport.onDataDisposable = terminal.onData((data) => {
		if (socket.readyState !== WebSocket.OPEN) return;
		logTerminalInput("ws-input", data.length, {
			terminalId: transport.debugId,
		});
		socket.send(JSON.stringify({ type: "input", data }));
	});
}

/**
 * Reset the reconnect backoff counter without touching the connection.
 * Call this on intentional reconnects (e.g. workspace switch) so the next
 * unexpected disconnect starts from the minimum delay again.
 */
export function resetReconnectBackoff(transport: TerminalTransport) {
	transport._reconnectAttempt = 0;
}

export function disconnect(transport: TerminalTransport) {
	cancelReconnect(transport);
	if (transport.socket) {
		transport.socket.close();
		transport.socket = null;
	}
	terminalRendererDebug.info(
		"ws-disconnect",
		{ terminalId: transport.debugId },
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "ws-disconnect"],
		},
	);
	transport.currentUrl = null;
	transport._terminal = null;
	transport._reconnectAttempt = 0;
	setTerminalTitle(transport, undefined);
	setConnectionState(transport, "disconnected");
	transport.onDataDisposable?.dispose();
	transport.onDataDisposable = null;
}

export function sendResize(
	transport: TerminalTransport,
	cols: number,
	rows: number,
) {
	if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN)
		return;
	transport.socket.send(JSON.stringify({ type: "resize", cols, rows }));
}

export function sendInput(transport: TerminalTransport, data: string) {
	if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN)
		return;
	transport.socket.send(JSON.stringify({ type: "input", data }));
}

export function sendDispose(transport: TerminalTransport) {
	if (transport.socket?.readyState === WebSocket.OPEN) {
		transport.socket.send(JSON.stringify({ type: "dispose" }));
	}
}

export function disposeTransport(transport: TerminalTransport) {
	cancelReconnect(transport);
	if (transport.socket) {
		transport.socket.close();
		transport.socket = null;
	}
	terminalRendererDebug.info(
		"ws-transport-dispose",
		{ terminalId: transport.debugId },
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "ws-transport-dispose"],
		},
	);
	transport.currentUrl = null;
	transport._terminal = null;
	transport._reconnectAttempt = 0;
	setTerminalTitle(transport, undefined);
	transport.onDataDisposable?.dispose();
	transport.onDataDisposable = null;
	transport.stateListeners.clear();
	transport.titleListeners.clear();
}
