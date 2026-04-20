import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
import { resolveCdpPort } from "./cdp-port";

/**
 * CDP (Chrome DevTools Protocol) filter proxy — per-session edition.
 *
 * External browser-automation MCPs (chrome-devtools-mcp / browser-use /
 * playwright-mcp / …) that use puppeteer internally expect a
 * `browserURL = http://host:port` *without* a path. They compose
 * `/json/version` against it, which strips any path prefix. Putting
 * the session token in the path therefore does not survive the client
 * side.
 *
 * So instead we give every LLM session its own dedicated loopback
 * HTTP+WS server. The port is persistent per session (saved in
 * `$SUPERSET_HOME_DIR/browser-mcp-sessions.json`) so the URL the user
 * registered into their external MCP stays valid across Superset
 * restarts. The server filters Chromium's `/json(/*)?` listing down
 * to the single pane bound to the owning session and transparently
 * proxies `/devtools/page/<targetId>` to Chromium.
 *
 * Security surface: loopback only, kernel-assigned port, no
 * path-embedded credentials — the port itself is the capability.
 *
 * Threat model: puppeteer's `connect({ browserURL })` composes
 * `new URL("/json/version", browserURL)`, which per WHATWG URL spec
 * drops any path, query, or auth on the base URL. It also does not
 * forward custom HTTP headers to `/json/version`. That rules out
 * path-token, query-token, and Bearer-header auth on this proxy — any
 * such secret would be silently stripped before Chromium is asked for
 * its target list. We therefore rely on the standard Chrome DevTools
 * security model: loopback binding + single-user-machine assumption.
 * A hostile *local* process on the same user account that can read
 * `~/.superset/browser-mcp-sessions.json` (0600) or port-scan loopback
 * can drive the bound pane; this matches Chromium's own
 * `--remote-debugging-port` threat model and is explicitly not in
 * scope for this proxy to fix. Multi-user hosts should not run
 * Superset desktop with browser automation enabled.
 */

const STORE_PATH = join(SUPERSET_HOME_DIR, "browser-mcp-sessions.json");

interface SessionRecord {
	sessionId: string;
	port: number;
	createdAt: number;
	lastUsedAt: number;
}

interface PersistedFile {
	version: 2;
	sessions: SessionRecord[];
}

const records = new Map<string, SessionRecord>();
const servers = new Map<string, Server>();
const inFlight = new Map<string, Promise<number>>();
let hydrated = false;

function hydrate(): void {
	if (hydrated) return;
	hydrated = true;
	try {
		const raw = readFileSync(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<PersistedFile>;
		if (parsed?.version !== 2 || !Array.isArray(parsed.sessions)) return;
		for (const s of parsed.sessions) {
			if (
				typeof s.sessionId === "string" &&
				typeof s.port === "number" &&
				Number.isInteger(s.port) &&
				s.port > 0 &&
				s.port < 65_536
			) {
				records.set(s.sessionId, {
					sessionId: s.sessionId,
					port: s.port,
					createdAt: s.createdAt ?? Date.now(),
					lastUsedAt: s.lastUsedAt ?? Date.now(),
				});
			}
		}
	} catch {
		/* no prior state, start fresh */
	}
}

function persist(): void {
	try {
		const payload: PersistedFile = {
			version: 2,
			sessions: Array.from(records.values()),
		};
		mkdirSync(dirname(STORE_PATH), { recursive: true });
		writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), {
			mode: 0o600,
		});
		// writeFileSync mode only applies to new files; force 0600 so an
		// existing file from an earlier run with looser permissions is
		// re-tightened.
		try {
			chmodSync(STORE_PATH, 0o600);
		} catch {
			/* best-effort */
		}
	} catch (error) {
		console.warn("[cdp-filter-proxy] failed to persist sessions:", error);
	}
}

async function tryBind(server: Server, port: number): Promise<number | null> {
	return new Promise((resolve) => {
		const onError = (): void => {
			server.off("error", onError);
			resolve(null);
		};
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				resolve(null);
				return;
			}
			resolve(addr.port);
		});
	});
}

async function bindSessionServer(
	preferredPort: number | undefined,
): Promise<{ server: Server; port: number; wss: WebSocketServer }> {
	const server = createServer();
	// Try preferred port first so restarts reuse the one the user
	// registered with; fall back to any free port on conflict.
	const bound =
		(preferredPort && (await tryBind(server, preferredPort))) ||
		(await tryBind(server, 0));
	if (!bound) {
		throw new Error("cdp-filter-proxy: failed to bind loopback port");
	}
	const wss = new WebSocketServer({ noServer: true });
	return { server, port: bound, wss };
}

function resolveBindingForSession(
	sessionId: string,
): { paneId: string; targetId: string } | null {
	const binding = bindingStore.getBySessionId(sessionId);
	if (!binding) return null;
	const targetId = browserManager.getCdpTargetId(binding.paneId);
	if (!targetId) return null;
	return { paneId: binding.paneId, targetId };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

async function fetchUpstreamJson(path: string): Promise<unknown> {
	const port = await resolveCdpPort();
	if (!port) throw new Error("Chromium CDP port not available");
	const res = await fetch(`http://127.0.0.1:${port}${path}`);
	if (!res.ok) {
		throw new Error(
			`Chromium CDP returned ${res.status} for ${path}: ${await res.text().catch(() => "")}`,
		);
	}
	return (await res.json()) as unknown;
}

function wireRequestHandler(server: Server, sessionId: string): void {
	server.on("request", async (req, res) => {
		try {
			const remote = req.socket.remoteAddress ?? "";
			if (
				remote !== "127.0.0.1" &&
				remote !== "::1" &&
				remote !== "::ffff:127.0.0.1"
			) {
				return sendJson(res, 403, { error: "loopback only" });
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const pathname = url.pathname.replace(/\/$/, "") || "/";
			if (pathname === "/json/version") {
				const body = (await fetchUpstreamJson("/json/version")) as Record<
					string,
					unknown
				>;
				// Chromium's /json/version exposes the browser-level
				// `webSocketDebuggerUrl` pointing at the raw CDP port, which
				// would bypass the filter. Drop it.
				const { webSocketDebuggerUrl: _drop, ...safe } = body;
				void _drop;
				return sendJson(res, 200, safe);
			}
			if (pathname === "/json/protocol") {
				const body = await fetchUpstreamJson("/json/protocol");
				return sendJson(res, 200, body);
			}
			if (pathname === "/json" || pathname === "/json/list") {
				const resolved = resolveBindingForSession(sessionId);
				if (!resolved) return sendJson(res, 200, []);
				const raw = (await fetchUpstreamJson("/json/list")) as Array<
					Record<string, unknown>
				>;
				const host = req.headers.host ?? "127.0.0.1";
				const out = raw
					.filter((t) => (t as { id?: string }).id === resolved.targetId)
					.map((t) => {
						const id = resolved.targetId;
						return {
							...t,
							webSocketDebuggerUrl: `ws://${host}/devtools/page/${id}`,
							devtoolsFrontendUrl: `http://${host}/devtools/page/${id}`,
						};
					});
				return sendJson(res, 200, out);
			}
			// Plain HTTP access to /devtools/page/<id> is not a real CDP
			// entry point — it needs a WS upgrade which is handled below.
			return sendJson(res, 404, { error: "not found" });
		} catch (error) {
			console.error("[cdp-filter-proxy] request error:", error);
			return sendJson(res, 502, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function wireUpgradeHandler(
	server: Server,
	wss: WebSocketServer,
	sessionId: string,
): void {
	server.on("upgrade", async (req, socket, head) => {
		const remote = req.socket.remoteAddress ?? "";
		if (
			remote !== "127.0.0.1" &&
			remote !== "::1" &&
			remote !== "::ffff:127.0.0.1"
		) {
			socket.destroy();
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (!/^\/devtools\/page\/[^/]+$/.test(pathname)) {
			socket.destroy();
			return;
		}
		const resolved = resolveBindingForSession(sessionId);
		if (!resolved) {
			socket.destroy();
			return;
		}
		const port = await resolveCdpPort();
		if (!port) {
			socket.destroy();
			return;
		}
		void proxyUpgrade(req, socket, head, wss, port, resolved.targetId);
	});
}

async function proxyUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
	chromiumPort: number,
	targetId: string,
): Promise<void> {
	wss.handleUpgrade(req, socket, head, (clientWs) => {
		const upstream = new WebSocket(
			`ws://127.0.0.1:${chromiumPort}/devtools/page/${targetId}`,
		);
		const closeBoth = (): void => {
			try {
				clientWs.close();
			} catch {
				/* ignore */
			}
			try {
				upstream.close();
			} catch {
				/* ignore */
			}
		};
		const pending: Array<Parameters<typeof upstream.send>[0]> = [];
		clientWs.on("message", (data) => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(data);
			} else {
				pending.push(data as Parameters<typeof upstream.send>[0]);
			}
		});
		upstream.on("open", () => {
			for (const buf of pending) upstream.send(buf);
			pending.length = 0;
			upstream.on("message", (data) => {
				if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
			});
		});
		upstream.on("error", (err) => {
			console.warn("[cdp-filter-proxy] upstream error", err);
			closeBoth();
		});
		upstream.on("close", closeBoth);
		clientWs.on("error", closeBoth);
		clientWs.on("close", closeBoth);
	});
}

/**
 * Ensure a dedicated loopback server exists for this LLM session and
 * return the port it is bound to. Idempotent — re-calls return the
 * same port for the same session, even across Superset restarts.
 */
export async function ensureSessionEndpoint(
	sessionId: string,
): Promise<number> {
	hydrate();
	const existing = records.get(sessionId);
	if (existing && servers.has(sessionId)) {
		existing.lastUsedAt = Date.now();
		return existing.port;
	}
	// Serialize concurrent calls for the same sessionId — otherwise both
	// callers miss `servers.has(...)` and each bind a different port,
	// then clobber each other in the maps.
	const pending = inFlight.get(sessionId);
	if (pending) return pending;
	const promise = (async () => {
		const { server, port, wss } = await bindSessionServer(existing?.port);
		wireRequestHandler(server, sessionId);
		wireUpgradeHandler(server, wss, sessionId);
		servers.set(sessionId, server);
		const record: SessionRecord = {
			sessionId,
			port,
			createdAt: existing?.createdAt ?? Date.now(),
			lastUsedAt: Date.now(),
		};
		records.set(sessionId, record);
		persist();
		return port;
	})().finally(() => {
		inFlight.delete(sessionId);
	});
	inFlight.set(sessionId, promise);
	return promise;
}

export function getSessionEndpointPort(sessionId: string): number | null {
	hydrate();
	return records.get(sessionId)?.port ?? null;
}

export function stopAllSessionEndpoints(): void {
	for (const server of servers.values()) {
		try {
			server.close();
		} catch {
			/* ignore */
		}
	}
	servers.clear();
}
