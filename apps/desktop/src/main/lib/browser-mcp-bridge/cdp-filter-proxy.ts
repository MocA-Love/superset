import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
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

/**
 * Per-server identifier used in `/devtools/browser/<id>` so the URL
 * Chromium itself would hand out looks identical in shape to ours.
 */
const browserWsIds = new Map<string, string>();

function browserWsIdFor(sessionId: string): string {
	let id = browserWsIds.get(sessionId);
	if (!id) {
		id = randomBytes(16).toString("hex");
		browserWsIds.set(sessionId, id);
	}
	return id;
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
			const host = req.headers.host ?? "127.0.0.1";
			if (pathname === "/json/version") {
				const body = (await fetchUpstreamJson("/json/version")) as Record<
					string,
					unknown
				>;
				// Replace Chromium's browser-level `webSocketDebuggerUrl` with
				// our filtered one. External clients (puppeteer.connect,
				// chrome-devtools-mcp, browser-use) rely on this field to
				// obtain a browser-level CDP connection. Routing it through
				// our proxy lets us filter the `Target.*` domain so they only
				// see the bound pane.
				const { webSocketDebuggerUrl: _drop, ...safe } = body;
				void _drop;
				return sendJson(res, 200, {
					...safe,
					webSocketDebuggerUrl: `ws://${host}/devtools/browser/${browserWsIdFor(sessionId)}`,
				});
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

		if (/^\/devtools\/browser\/[^/]+$/.test(pathname)) {
			const expected = `/devtools/browser/${browserWsIdFor(sessionId)}`;
			if (pathname !== expected) {
				socket.destroy();
				return;
			}
			void proxyBrowserUpgrade(req, socket, head, wss, port, resolved);
			return;
		}
		if (/^\/devtools\/page\/[^/]+$/.test(pathname)) {
			void proxyPageUpgrade(req, socket, head, wss, port, resolved.targetId);
			return;
		}
		socket.destroy();
	});
}

async function proxyPageUpgrade(
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
			console.warn("[cdp-filter-proxy] page upstream error", err);
			closeBoth();
		});
		upstream.on("close", closeBoth);
		clientWs.on("error", closeBoth);
		clientWs.on("close", closeBoth);
	});
}

/* ---------------------------------------------------------------- */
/* Browser-level CDP filter.                                         */
/*                                                                   */
/* Client is talking to our proxy as if we were Chromium's browser-  */
/* level CDP endpoint. We forward most messages through to the real  */
/* browser WS but rewrite the `Target` domain so the client only     */
/* ever sees the single pane bound to this session:                  */
/*                                                                   */
/*   • Target.getTargets / targetCreated / targetDestroyed           */
/*     / targetInfoChanged — filtered to bound paneId                */
/*   • Target.attachToTarget / setAutoAttach — allowed, but limited  */
/*     to bound paneId; other ids get a CDP error                    */
/*   • Target.createTarget — treated as "navigate the bound pane"    */
/*     (per user decision: the pane is already under attached        */
/*     automation, so redirecting a new-tab request into a           */
/*     Page.navigate on the bound pane is the expected UX)           */
/*   • Target.closeTarget / disposeBrowserContext / Browser.close    */
/*     — rejected, so MCPs cannot shut the pane or Chromium down     */
/*                                                                   */
/* Session-scoped messages (CDP frames carrying `sessionId`) are     */
/* forwarded verbatim — once a client is attached to the bound pane  */
/* it speaks Page/DOM/Runtime/… directly with Chromium.              */
/* ---------------------------------------------------------------- */

interface JsonRpcMsg {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
	sessionId?: string;
}

function isTargetInfoForBound(
	info: unknown,
	boundTargetId: string,
): info is { targetId: string } {
	return (
		typeof info === "object" &&
		info !== null &&
		(info as { targetId?: unknown }).targetId === boundTargetId
	);
}

async function proxyBrowserUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
	chromiumPort: number,
	resolved: { paneId: string; targetId: string },
): Promise<void> {
	// Chromium's real browser WS URL — fetch /json/version to discover
	// it. The `id` in the path is per Chromium run, not per target.
	let chromiumBrowserWs: string;
	try {
		const ver = (await fetchUpstreamJson("/json/version")) as {
			webSocketDebuggerUrl?: string;
		};
		if (!ver.webSocketDebuggerUrl) {
			socket.destroy();
			return;
		}
		// Rewrite host:port to our resolved Chromium CDP port (in case
		// /json/version returned a different hostname).
		const parsed = new URL(ver.webSocketDebuggerUrl);
		parsed.host = `127.0.0.1:${chromiumPort}`;
		chromiumBrowserWs = parsed.toString();
	} catch (error) {
		console.warn("[cdp-filter-proxy] could not resolve browser WS:", error);
		socket.destroy();
		return;
	}

	wss.handleUpgrade(req, socket, head, (clientWs) => {
		const upstream = new WebSocket(chromiumBrowserWs);
		const boundTargetId = resolved.targetId;
		// Map outgoing request id → original method so we can filter
		// responses for Target.getTargets etc. Chromium echoes `id` back.
		const pendingMethods = new Map<number, string>();

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

		const sendToClient = (obj: unknown): void => {
			if (clientWs.readyState !== WebSocket.OPEN) return;
			try {
				clientWs.send(JSON.stringify(obj));
			} catch {
				/* ignore */
			}
		};
		const sendToUpstream = (obj: unknown): void => {
			if (upstream.readyState !== WebSocket.OPEN) return;
			try {
				upstream.send(JSON.stringify(obj));
			} catch {
				/* ignore */
			}
		};

		const rejectRequest = (id: number, message: string): void => {
			sendToClient({ id, error: { code: -32601, message } });
		};

		// Incoming (client → us). Most messages are forwarded; Target.*
		// is filtered; known-destructive calls are rejected.
		clientWs.on("message", (data: RawData) => {
			let msg: JsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as JsonRpcMsg;
			} catch {
				return;
			}
			// Session-scoped frames: always forward (Page/DOM/Runtime/etc
			// speak to an already-attached page).
			if (msg.sessionId) {
				sendToUpstream(msg);
				return;
			}
			const method = msg.method ?? "";
			const id = typeof msg.id === "number" ? msg.id : undefined;

			// Hard-rejected methods — these would let a hostile MCP tear
			// down the pane or browser.
			if (
				method === "Target.closeTarget" ||
				method === "Target.disposeBrowserContext" ||
				method === "Target.createBrowserContext" ||
				method === "Browser.close" ||
				method === "Browser.crash" ||
				method === "Browser.crashGpuProcess"
			) {
				if (id !== undefined) {
					rejectRequest(
						id,
						`${method} is not permitted by the Superset CDP filter`,
					);
				}
				return;
			}

			// Scope enforcement: attaches must target the bound pane.
			if (method === "Target.attachToTarget" && id !== undefined) {
				const targetId = (msg.params as { targetId?: string } | undefined)
					?.targetId;
				if (targetId && targetId !== boundTargetId) {
					rejectRequest(
						id,
						"This Superset session is scoped to a single bound pane; attachToTarget for other targets is refused.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			// createTarget → navigate the bound pane (option B). We do
			// NOT create a real new target in Chromium; instead we:
			//   1. trigger a navigation on the bound pane if a URL was
			//      supplied, via the main process's BrowserView handle
			//      (side-channel, not upstream CDP);
			//   2. respond with `{targetId: boundTargetId}` so the MCP
			//      treats the bound pane as "the new page".
			if (method === "Target.createTarget" && id !== undefined) {
				const params = msg.params as
					| { url?: string; background?: boolean }
					| undefined;
				const nextUrl = params?.url;
				if (nextUrl && typeof nextUrl === "string" && nextUrl !== "") {
					try {
						const wc = browserManager.getWebContents(resolved.paneId);
						if (wc && !wc.isDestroyed() && !/^about:blank$/i.test(nextUrl)) {
							void wc.loadURL(nextUrl).catch(() => {
								/* loadURL can reject on aborted nav; ignore */
							});
						}
					} catch {
						/* best-effort — the respond-with-bound flow still works */
					}
				}
				sendToClient({ id, result: { targetId: boundTargetId } });
				return;
			}

			if (
				method === "Target.getTargets" ||
				method === "Target.getTargetInfo"
			) {
				if (id !== undefined) pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			// Other Target.* methods (setAutoAttach, setDiscoverTargets,
			// detachFromTarget, activateTarget, …): forward.
			if (id !== undefined) pendingMethods.set(id, method);
			sendToUpstream(msg);
		});

		// Outgoing (upstream → client). Filter Target events and Target
		// responses so the client only sees the bound pane.
		upstream.on("message", (data: RawData) => {
			let msg: JsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as JsonRpcMsg;
			} catch {
				return;
			}
			// Session-scoped event/response: always forward.
			if (msg.sessionId) {
				sendToClient(msg);
				return;
			}

			// Responses.
			if (typeof msg.id === "number") {
				const origMethod = pendingMethods.get(msg.id);
				pendingMethods.delete(msg.id);
				if (origMethod === "Target.getTargets" && msg.result) {
					const infos = (msg.result.targetInfos ?? []) as unknown[];
					const filtered = infos.filter((i) =>
						isTargetInfoForBound(i, boundTargetId),
					);
					sendToClient({
						...msg,
						result: { ...msg.result, targetInfos: filtered },
					});
					return;
				}
				if (origMethod === "Target.getTargetInfo" && msg.result?.targetInfo) {
					if (!isTargetInfoForBound(msg.result.targetInfo, boundTargetId)) {
						sendToClient({
							id: msg.id,
							error: { code: -32000, message: "target not found" },
						});
						return;
					}
				}
				sendToClient(msg);
				return;
			}

			// Events.
			const method = msg.method ?? "";
			if (
				method === "Target.targetCreated" ||
				method === "Target.targetDestroyed" ||
				method === "Target.targetInfoChanged" ||
				method === "Target.targetCrashed"
			) {
				const info =
					(msg.params as { targetInfo?: unknown; targetId?: string } | undefined)
						?.targetInfo ?? msg.params;
				const tid =
					(info as { targetId?: string } | undefined)?.targetId ??
					(msg.params as { targetId?: string } | undefined)?.targetId;
				if (tid !== boundTargetId) return; // drop
				sendToClient(msg);
				return;
			}
			if (method === "Target.attachedToTarget") {
				const tid = (
					msg.params as { targetInfo?: { targetId?: string } } | undefined
				)?.targetInfo?.targetId;
				if (tid !== boundTargetId) return;
				sendToClient(msg);
				return;
			}
			sendToClient(msg);
		});

		upstream.on("error", (err) => {
			console.warn("[cdp-filter-proxy] browser upstream error", err);
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
