import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
import {
	type BoundContext,
	browserWsIdFor,
	fetchUpstreamJson,
	proxyBrowserUpgrade,
	proxyPageUpgrade,
	sendJson,
} from "./cdp-filter-proxy";
import { resolveCdpPort } from "./cdp-port";
import { resolvePidToSession } from "./pane-resolver";
import { resolvePeerPidFromRemotePort } from "./peer-pid";

/**
 * Single-port CDP gateway.
 *
 * Serves the endpoints external CDP MCPs expect (`/json/*`,
 * `/devtools/browser/<id>`, `/devtools/page/<id>`) on the bridge port
 * (47834) and resolves which LLM session (and therefore which bound
 * pane) the caller belongs to *per connection* via a loopback peer-PID
 * walk — so the registration URL stays constant across Superset / OS
 * restarts, pane rebindings, and new terminal panes.
 *
 * Security: loopback-only. The peer-PID walk additionally requires the
 * caller to descend from a live Superset terminal pane.
 *
 * These endpoints are unauthenticated because puppeteer composes
 * `new URL("/json/version", browserURL)` and drops any path/query/
 * Authorization header from the base URL. Capability is instead the
 * peer-PID tree-descendant check.
 */

const wss = new WebSocketServer({ noServer: true });

const GLOBAL_BROWSER_USE_CONFIG_PATH = join(
	SUPERSET_HOME_DIR,
	"browser-use-mcp.json",
);

export function getGlobalBrowserUseConfigPath(): string {
	return GLOBAL_BROWSER_USE_CONFIG_PATH;
}

export function ensureGlobalBrowserUseConfig(bridgePort: number): void {
	const payload = {
		browser_profile: {
			"superset-gateway": {
				id: "superset-gateway",
				default: true,
				cdp_url: `http://127.0.0.1:${bridgePort}`,
			},
		},
		llm: {},
		agent: {},
	};
	try {
		mkdirSync(dirname(GLOBAL_BROWSER_USE_CONFIG_PATH), { recursive: true });
		writeFileSync(
			GLOBAL_BROWSER_USE_CONFIG_PATH,
			JSON.stringify(payload, null, 2),
			{ mode: 0o600 },
		);
		try {
			chmodSync(GLOBAL_BROWSER_USE_CONFIG_PATH, 0o600);
		} catch {
			/* best effort */
		}
	} catch (error) {
		console.warn(
			"[cdp-gateway] failed to write global browser-use config:",
			error,
		);
	}
}

/**
 * Session resolution is keyed to the TCP socket (peer-PID lookup is
 * expensive and the socket identifies a single external MCP process),
 * but the paneId binding is intentionally NOT cached — a keep-alive
 * HTTP connection crossing a pane rebind must pick up the new pane on
 * the next request.
 */
const socketSessions = new WeakMap<Socket, Promise<string | null>>();

async function resolveSessionForSocket(socket: Socket): Promise<string | null> {
	const cached = socketSessions.get(socket);
	if (cached) return cached;
	const promise = (async () => {
		if (
			socket.remoteAddress !== "127.0.0.1" &&
			socket.remoteAddress !== "::1" &&
			socket.remoteAddress !== "::ffff:127.0.0.1"
		) {
			console.log("[cdp-gateway] reject non-loopback", socket.remoteAddress);
			return null;
		}
		const remotePort = socket.remotePort;
		if (typeof remotePort !== "number") return null;
		const peerPid = await resolvePeerPidFromRemotePort(remotePort, process.pid);
		if (!peerPid) {
			console.log(
				"[cdp-gateway] peer-PID lookup failed for remotePort",
				remotePort,
			);
			return null;
		}
		const session = await resolvePidToSession(peerPid);
		if (!session?.sessionId) {
			console.log(
				"[cdp-gateway] peerPid",
				peerPid,
				"did not resolve to any Superset terminal pane",
			);
			return null;
		}
		const binding = bindingStore.getBySessionId(session.sessionId);
		console.log(
			"[cdp-gateway] resolved peerPid",
			peerPid,
			"→ session",
			session.sessionId,
			"binding=",
			binding ? binding.paneId : "(none)",
		);
		return session.sessionId;
	})();
	socketSessions.set(socket, promise);
	return promise;
}

async function resolveForSocket(
	socket: Socket,
): Promise<{ paneId: string; sessionId: string } | null> {
	const sessionId = await resolveSessionForSocket(socket);
	if (!sessionId) return null;
	const binding = bindingStore.getBySessionId(sessionId);
	if (!binding) return null;
	return { paneId: binding.paneId, sessionId };
}

/* ---------------------------------------------------------------- */
/* M3: close active CDP connections for a session when its binding   */
/* changes, so external MCPs reconnect next tool call and            */
/* transparently pick up the new pane.                               */
/* ---------------------------------------------------------------- */

const sessionConnections = new Map<string, Set<WebSocket>>();

function registerConnection(sessionId: string, ws: WebSocket): void {
	let set = sessionConnections.get(sessionId);
	if (!set) {
		set = new Set<WebSocket>();
		sessionConnections.set(sessionId, set);
	}
	set.add(ws);
	ws.on("close", () => {
		set?.delete(ws);
		if (set && set.size === 0) sessionConnections.delete(sessionId);
	});
}

function closeConnectionsForSession(sessionId: string): void {
	const set = sessionConnections.get(sessionId);
	if (!set) return;
	console.log(
		"[cdp-gateway] M3 closing",
		set.size,
		"connections for session",
		sessionId,
	);
	for (const ws of Array.from(set)) {
		try {
			ws.close(1000, "superset: binding changed, reconnect");
		} catch {
			/* ignore */
		}
	}
	sessionConnections.delete(sessionId);
}

let bindingChangeWatcherInstalled = false;
const lastBindingBySession = new Map<string, string>();

function installBindingChangeWatcher(): void {
	if (bindingChangeWatcherInstalled) return;
	bindingChangeWatcherInstalled = true;
	for (const b of bindingStore.list()) {
		lastBindingBySession.set(b.sessionId, b.paneId);
	}
	bindingStore.onChange((list) => {
		const next = new Map<string, string>();
		for (const b of list) next.set(b.sessionId, b.paneId);
		// Session removed → close.
		for (const [sid] of lastBindingBySession) {
			if (!next.has(sid)) closeConnectionsForSession(sid);
		}
		// Pane changed → close so client reconnects with new binding.
		for (const [sid, paneId] of next) {
			const prev = lastBindingBySession.get(sid);
			if (prev && prev !== paneId) closeConnectionsForSession(sid);
		}
		lastBindingBySession.clear();
		for (const [k, v] of next) lastBindingBySession.set(k, v);
	});
}

function makeBoundContext(resolved: {
	paneId: string;
	sessionId: string;
}): BoundContext | null {
	const primary = browserManager.getCdpTargetId(resolved.paneId);
	if (!primary) return null;
	return {
		paneId: resolved.paneId,
		primaryTargetId: primary,
		boundTargetIds: () => {
			// M1/M2 bridge: ask browserManager for the pane's current
			// target set. In single-tab mode this is a singleton; with
			// multi-tab enabled it returns every tab. Falls back to the
			// primary when no registry is available.
			const all = browserManager.getPaneTargetIds?.(resolved.paneId);
			if (all && all.size > 0) return all;
			return new Set([primary]);
		},
		onClose: (ws) => {
			registerConnection(resolved.sessionId, ws);
		},
	};
}

export function isCdpGatewayPath(pathname: string): boolean {
	const p = pathname.replace(/\/$/, "") || "/";
	return (
		p === "/json" ||
		p === "/json/list" ||
		p === "/json/version" ||
		p === "/json/protocol"
	);
}

export function isCdpGatewayUpgradePath(pathname: string): boolean {
	return (
		/^\/devtools\/browser\/[^/]+$/.test(pathname) ||
		/^\/devtools\/page\/[^/]+$/.test(pathname)
	);
}

export async function handleCdpGatewayRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	installBindingChangeWatcher();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname.replace(/\/$/, "") || "/";
	try {
		const resolved = await resolveForSocket(req.socket as Socket);
		if (!resolved) {
			console.log(
				"[cdp-gateway] 409 for",
				pathname,
				"| current bindings:",
				bindingStore.list().map((b) => `${b.sessionId}→${b.paneId}`),
			);
			sendJson(res, 409, {
				error:
					"このLLMセッションにはブラウザペインが接続されていません。Supersetの「Connect」で対象ペインをアタッチしてください。",
			});
			return;
		}
		const primary = browserManager.getCdpTargetId(resolved.paneId);
		if (!primary) {
			sendJson(res, 503, {
				error:
					"バインド済みペインのCDPターゲット準備がまだ完了していません。少し待って再試行してください。",
			});
			return;
		}

		const host = req.headers.host ?? "127.0.0.1";
		if (pathname === "/json/version") {
			const body = (await fetchUpstreamJson("/json/version")) as Record<
				string,
				unknown
			>;
			const { webSocketDebuggerUrl: _drop, ...safe } = body;
			void _drop;
			sendJson(res, 200, {
				...safe,
				webSocketDebuggerUrl: `ws://${host}/devtools/browser/${browserWsIdFor(resolved.sessionId)}`,
			});
			return;
		}
		if (pathname === "/json/protocol") {
			const body = await fetchUpstreamJson("/json/protocol");
			sendJson(res, 200, body);
			return;
		}
		// /json or /json/list
		const raw = (await fetchUpstreamJson("/json/list")) as Array<
			Record<string, unknown>
		>;
		const boundSet =
			browserManager.getPaneTargetIds?.(resolved.paneId) ?? new Set([primary]);
		const out = raw
			.filter((t) => {
				const id = (t as { id?: string }).id;
				return typeof id === "string" && boundSet.has(id);
			})
			.map((t) => {
				const id = (t as { id?: string }).id ?? primary;
				// Electron exposes its <webview> / BrowserView tags as
				// `type: "webview"` in /json/list. puppeteer-core's
				// `browser.pages()` only counts targets whose type is
				// `page`, so leaving "webview" through would make
				// chrome-devtools-mcp's `list_pages` / `evaluate_script`
				// return empty even when the bound pane is alive. Rewrite
				// the type on the way out.
				const type = (t as { type?: string }).type;
				return {
					...t,
					type: type === "webview" ? "page" : type,
					webSocketDebuggerUrl: `ws://${host}/devtools/page/${id}`,
					devtoolsFrontendUrl: `http://${host}/devtools/page/${id}`,
				};
			});
		sendJson(res, 200, out);
	} catch (error) {
		console.error("[cdp-gateway] request error:", error);
		sendJson(res, 502, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function handleCdpGatewayUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<void> {
	installBindingChangeWatcher();
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	const isBrowserPath = /^\/devtools\/browser\/[^/]+$/.test(pathname);
	const isPagePath = /^\/devtools\/page\/[^/]+$/.test(pathname);
	if (!isBrowserPath && !isPagePath) {
		socket.destroy();
		return;
	}
	const s = socket as unknown as Socket;
	if (
		s.remoteAddress !== "127.0.0.1" &&
		s.remoteAddress !== "::1" &&
		s.remoteAddress !== "::ffff:127.0.0.1"
	) {
		socket.destroy();
		return;
	}
	const resolved = await resolveForSocket(s);
	if (!resolved) {
		socket.destroy();
		return;
	}
	const ctx = makeBoundContext(resolved);
	if (!ctx) {
		socket.destroy();
		return;
	}
	const port = await resolveCdpPort();
	if (!port) {
		socket.destroy();
		return;
	}
	if (isBrowserPath) {
		const expected = `/devtools/browser/${browserWsIdFor(resolved.sessionId)}`;
		if (pathname !== expected) {
			socket.destroy();
			return;
		}
		void proxyBrowserUpgrade(req, socket, head, wss, port, ctx);
		return;
	}
	// Page-level upgrade: ensure the requested target is in the bound set.
	const m = pathname.match(/^\/devtools\/page\/([^/]+)$/);
	const tid = m?.[1];
	if (!tid || !ctx.boundTargetIds().has(tid)) {
		socket.destroy();
		return;
	}
	void proxyPageUpgrade(req, socket, head, wss, port, tid);
}
