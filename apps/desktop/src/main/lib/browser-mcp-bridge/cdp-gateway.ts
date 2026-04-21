import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";
import { browserManager } from "../browser/browser-manager";
import {
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
 * Shares the bridge's HTTP server on port 47834 and serves the
 * endpoints external CDP MCPs (chrome-devtools-mcp, browser-use,
 * playwright-mcp) expect:
 *
 *   GET /json/version            — rewritten browser WS URL
 *   GET /json, /json/list        — filtered to bound pane
 *   GET /json/protocol           — forwarded
 *   WS  /devtools/browser/<id>   — filtered browser-level CDP
 *   WS  /devtools/page/<id>      — page-level CDP for bound target
 *
 * Unlike the deprecated per-session port model — which baked a
 * specific LLM session into a dedicated HTTP+WS server — the gateway
 * resolves the calling LLM session *per connection* by walking the
 * TCP peer PID up through the Superset terminal PTY process tree.
 * This lets the external MCP registration URL stay constant across
 * sessions, Superset / macOS restarts, pane rebindings, and new
 * terminal panes.
 *
 * Security: loopback-only. The peer-PID walk additionally requires
 * the caller to descend from a live Superset terminal pane; any
 * local process outside that tree is rejected. This is strictly
 * stronger than Chromium's own `--remote-debugging-port` model.
 *
 * These endpoints are *explicitly* authentication-free because
 * puppeteer composes `new URL("/json/version", browserURL)` and
 * drops any path/query/Authorization-header from the base URL, so
 * no secret-in-URL / Bearer scheme can survive. Capability is the
 * peer-PID tree-descendant check.
 */

const wss = new WebSocketServer({ noServer: true });

/* ---------------------------------------------------------------- */
/* Global browser-use config (stable across all sessions).           */
/*                                                                   */
/* browser-use's --mcp branch ignores --cdp-url and only honours the */
/* default browser_profile entry in the JSON pointed to by           */
/* BROWSER_USE_CONFIG_PATH. Since the gateway URL is now stable      */
/* (session is resolved per-connection, not per-port), one config   */
/* file suffices for every Superset install and never has to be      */
/* updated by the UI.                                                */
/* ---------------------------------------------------------------- */

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
		console.warn("[cdp-gateway] failed to write global browser-use config:", error);
	}
}

const socketSessions = new WeakMap<
	Socket,
	Promise<{ paneId: string; sessionId: string } | null>
>();

async function resolveForSocket(
	socket: Socket,
): Promise<{ paneId: string; sessionId: string } | null> {
	const cached = socketSessions.get(socket);
	if (cached) return cached;
	const promise = (async () => {
		if (
			socket.remoteAddress !== "127.0.0.1" &&
			socket.remoteAddress !== "::1" &&
			socket.remoteAddress !== "::ffff:127.0.0.1"
		) {
			return null;
		}
		const remotePort = socket.remotePort;
		if (typeof remotePort !== "number") return null;
		const peerPid = await resolvePeerPidFromRemotePort(
			remotePort,
			process.pid,
		);
		if (!peerPid) return null;
		const session = await resolvePidToSession(peerPid);
		if (!session?.paneId) return null;
		const binding = bindingStore.getBySessionId(session.sessionId);
		if (!binding) return null;
		return { paneId: binding.paneId, sessionId: session.sessionId };
	})();
	socketSessions.set(socket, promise);
	return promise;
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
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname.replace(/\/$/, "") || "/";
	try {
		const resolved = await resolveForSocket(req.socket as Socket);
		if (!resolved) {
			sendJson(res, 409, {
				error:
					"このLLMセッションにはブラウザペインが接続されていません。Supersetの「Connect」で対象ペインをアタッチしてください。",
			});
			return;
		}
		const targetId = browserManager.getCdpTargetId(resolved.paneId);
		if (!targetId) {
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
		const out = raw
			.filter((t) => (t as { id?: string }).id === targetId)
			.map((t) => ({
				...t,
				webSocketDebuggerUrl: `ws://${host}/devtools/page/${targetId}`,
				devtoolsFrontendUrl: `http://${host}/devtools/page/${targetId}`,
			}));
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
	const targetId = browserManager.getCdpTargetId(resolved.paneId);
	if (!targetId) {
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
		void proxyBrowserUpgrade(req, socket, head, wss, port, {
			paneId: resolved.paneId,
			targetId,
		});
		return;
	}
	void proxyPageUpgrade(req, socket, head, wss, port, targetId);
}
