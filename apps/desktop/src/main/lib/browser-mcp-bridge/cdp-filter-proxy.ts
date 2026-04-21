import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, type WebSocketServer } from "ws";
import { browserManager } from "../browser/browser-manager";
import { resolveCdpPort } from "./cdp-port";

/**
 * CDP filter helpers reused by the single-port gateway (cdp-gateway.ts).
 *
 * These functions translate a loopback client's browser-level or
 * page-level CDP session into one that only sees the bound pane's
 * targets. Session routing lives in the gateway — this module is
 * concerned with *message-level* filtering once the peer-PID → session
 * → bound pane lookup has already happened.
 *
 * Invariants the gateway relies on:
 *   • `/devtools/browser/<id>` → proxyBrowserUpgrade. The client
 *     observes only targetIds in the pane's bound set. `Target.*`
 *     methods that would affect unrelated targets or tear down the
 *     browser are rejected with a CDP error.
 *   • `/devtools/page/<id>` → proxyPageUpgrade. Transparent forward
 *     of the single page session; scope is already enforced by the
 *     gateway's targetId check.
 *   • `Target.setAutoAttach` has its `filter` stripped so
 *     puppeteer-based clients (chrome-devtools-mcp) don't hang when
 *     Electron's Chromium doesn't expose a `tab` wrapper above the
 *     page.
 *   • Session-scoped frames are admitted only for sessionIds we
 *     surfaced via `Target.attachedToTarget`; nested attach events
 *     add their child sessionId transitively, which is required for
 *     workers / OOPIF / prerender sub-sessions.
 */

export function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

export async function fetchUpstreamJson(path: string): Promise<unknown> {
	const port = await resolveCdpPort();
	if (!port) throw new Error("Chromium CDP port not available");
	const res = await fetch(`http://127.0.0.1:${port}${path}`);
	if (!res.ok) {
		throw new Error(
			`Chromium CDP returned ${res.status} for ${path}: ${await res
				.text()
				.catch(() => "")}`,
		);
	}
	return (await res.json()) as unknown;
}

/**
 * Per-session identifier used in `/devtools/browser/<id>` so the URL
 * the client sees has the same shape Chromium itself would hand out.
 */
const browserWsIds = new Map<string, string>();

export function browserWsIdFor(sessionId: string): string {
	let id = browserWsIds.get(sessionId);
	if (!id) {
		id = randomBytes(16).toString("hex");
		browserWsIds.set(sessionId, id);
	}
	return id;
}

export async function proxyPageUpgrade(
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

interface JsonRpcMsg {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
	sessionId?: string;
}

/**
 * Binding contract for the browser-level filter.
 *
 * Single-pane (M1) passes `primaryTargetId` as the one bound target
 * and returns `{primaryTargetId}` from boundTargetIds(). Multi-tab
 * (M2) returns the full Set of tab targetIds for the pane; the filter
 * does not need to know about tabs as such.
 */
export interface BoundContext {
	paneId: string;
	primaryTargetId: string;
	/** Current set of bound targetIds. Re-evaluated on each filter hit. */
	boundTargetIds(): ReadonlySet<string>;
	/** Optional: WS that should be closed when the bound set changes. */
	onClose?: (ws: WebSocket) => void;
}

function targetIdOf(obj: unknown): string | undefined {
	if (typeof obj !== "object" || obj === null) return undefined;
	const t = (obj as { targetId?: unknown }).targetId;
	return typeof t === "string" ? t : undefined;
}

export async function proxyBrowserUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
	chromiumPort: number,
	ctx: BoundContext,
): Promise<void> {
	let chromiumBrowserWs: string;
	try {
		const ver = (await fetchUpstreamJson("/json/version")) as {
			webSocketDebuggerUrl?: string;
		};
		if (!ver.webSocketDebuggerUrl) {
			socket.destroy();
			return;
		}
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
		const pendingMethods = new Map<number, string>();
		const allowedSessionIds = new Set<string>();
		if (ctx.onClose) ctx.onClose(clientWs);

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

		clientWs.on("message", (data: RawData) => {
			let msg: JsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as JsonRpcMsg;
			} catch {
				return;
			}
			if (msg.sessionId) {
				if (allowedSessionIds.has(msg.sessionId)) sendToUpstream(msg);
				return;
			}
			const method = msg.method ?? "";
			const id = typeof msg.id === "number" ? msg.id : undefined;
			const bound = ctx.boundTargetIds();

			if (
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

			// setAutoAttach: strip the `filter` field so Chromium does
			// NOT honour a client-side `{type:'page', exclude:true}`
			// exclusion that would wait for a tab wrapper Electron's
			// embedded Chromium does not always expose.
			if (method === "Target.setAutoAttach" && id !== undefined) {
				const original = (msg.params ?? {}) as Record<string, unknown>;
				const rewritten: Record<string, unknown> = { ...original };
				if ("filter" in rewritten) delete rewritten.filter;
				pendingMethods.set(id, method);
				sendToUpstream({ id, method, params: rewritten });
				return;
			}

			if (method === "Target.attachToTarget" && id !== undefined) {
				const targetId = targetIdOf(msg.params);
				if (targetId && !bound.has(targetId)) {
					rejectRequest(
						id,
						"This Superset session is scoped to the bound pane; attachToTarget for other targets is refused.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (method === "Target.activateTarget" && id !== undefined) {
				const tid = targetIdOf(msg.params);
				if (tid && !bound.has(tid)) {
					rejectRequest(
						id,
						"Target.activateTarget for other targets is refused by the Superset CDP filter.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (method === "Target.closeTarget" && id !== undefined) {
				const tid = targetIdOf(msg.params);
				if (!tid || !bound.has(tid)) {
					rejectRequest(
						id,
						"Target.closeTarget for other targets is refused by the Superset CDP filter.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (method === "Target.createTarget" && id !== undefined) {
				const params = msg.params as
					| { url?: string; background?: boolean; newWindow?: boolean }
					| undefined;
				const nextUrl =
					typeof params?.url === "string" && params.url !== ""
						? params.url
						: "about:blank";
				// Emit a renderer-side "create tab" request. The
				// BrowserPane subscribes via browser.onCreateTabRequested
				// and creates a real <webview> tab, which then registers
				// its webContents and targetId with browserManager. Once
				// that targetId lands in the bound set the MCP's next
				// `Target.getTargets` / `Target.attachToTarget` will find
				// it. We respond synchronously with the primary targetId
				// so puppeteer's newPage path resolves; subsequent
				// auto-attach events for the new tab surface the real
				// targetId to the client through our normal filter.
				try {
					browserManager.emit(`create-tab-requested:${ctx.paneId}`, {
						url: nextUrl,
					});
				} catch {
					/* best effort */
				}
				sendToClient({ id, result: { targetId: ctx.primaryTargetId } });
				return;
			}

			if (method === "Target.getTargets" || method === "Target.getTargetInfo") {
				if (id !== undefined) pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (method === "Target.detachFromTarget" && id !== undefined) {
				const sid = (msg.params as { sessionId?: string } | undefined)
					?.sessionId;
				if (sid && !allowedSessionIds.has(sid)) {
					rejectRequest(
						id,
						"Target.detachFromTarget for unknown sessions is refused by the Superset CDP filter.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			if (id !== undefined) pendingMethods.set(id, method);
			sendToUpstream(msg);
		});

		upstream.on("message", (data: RawData) => {
			let msg: JsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as JsonRpcMsg;
			} catch {
				return;
			}
			const bound = ctx.boundTargetIds();

			if (msg.sessionId) {
				if (!allowedSessionIds.has(msg.sessionId)) return;
				if (msg.method === "Target.attachedToTarget") {
					const childSid = (msg.params as { sessionId?: string } | undefined)
						?.sessionId;
					if (childSid) allowedSessionIds.add(childSid);
				} else if (msg.method === "Target.detachedFromTarget") {
					const childSid = (msg.params as { sessionId?: string } | undefined)
						?.sessionId;
					if (childSid) allowedSessionIds.delete(childSid);
				}
				sendToClient(msg);
				return;
			}

			if (typeof msg.id === "number") {
				const origMethod = pendingMethods.get(msg.id);
				pendingMethods.delete(msg.id);
				if (origMethod === "Target.getTargets" && msg.result) {
					const infos = (msg.result.targetInfos ?? []) as unknown[];
					const filtered = infos.filter((i) => {
						const tid = targetIdOf(i);
						return tid !== undefined && bound.has(tid);
					});
					sendToClient({
						...msg,
						result: { ...msg.result, targetInfos: filtered },
					});
					return;
				}
				if (origMethod === "Target.attachToTarget" && msg.result) {
					const sid = (msg.result as { sessionId?: string }).sessionId;
					if (sid) allowedSessionIds.add(sid);
				}
				if (origMethod === "Target.getTargetInfo" && msg.result?.targetInfo) {
					const tid = targetIdOf(msg.result.targetInfo);
					if (!tid || !bound.has(tid)) {
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

			const method = msg.method ?? "";
			if (
				method === "Target.targetCreated" ||
				method === "Target.targetDestroyed" ||
				method === "Target.targetInfoChanged" ||
				method === "Target.targetCrashed"
			) {
				const info =
					(
						msg.params as
							| { targetInfo?: unknown; targetId?: string }
							| undefined
					)?.targetInfo ?? msg.params;
				const tid =
					targetIdOf(info) ??
					(msg.params as { targetId?: string } | undefined)?.targetId;
				if (!tid || !bound.has(tid)) return;
				sendToClient(msg);
				return;
			}
			if (method === "Target.attachedToTarget") {
				const params = msg.params as
					| { sessionId?: string; targetInfo?: { targetId?: string } }
					| undefined;
				const tid = params?.targetInfo?.targetId;
				if (!tid || !bound.has(tid)) return;
				if (params?.sessionId) allowedSessionIds.add(params.sessionId);
				sendToClient(msg);
				return;
			}
			if (method === "Target.detachedFromTarget") {
				const sid = (msg.params as { sessionId?: string } | undefined)
					?.sessionId;
				if (!sid || !allowedSessionIds.has(sid)) return;
				allowedSessionIds.delete(sid);
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
