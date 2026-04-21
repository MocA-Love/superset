import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { webContents as electronWebContents } from "electron";
import { type RawData, WebSocket, type WebSocketServer } from "ws";
import { browserManager } from "../browser/browser-manager";
import { resolveCdpPort } from "./cdp-port";
import {
	checkMethodPermitted,
	isPrivilegedSchemeAllowed,
	permissionStore,
} from "./permissions";

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

/**
 * Electron's BrowserView / <webview> shows up in Chromium's CDP as
 * `type: "webview"`. puppeteer-core's `browser.pages()` filters by
 * `type === "page"`, so the unchanged type would make chrome-devtools-
 * mcp's `list_pages` / `evaluate_script` see zero pages even when the
 * bound pane is alive. We rewrite "webview" to "page" on the way out
 * so external CDP clients treat the pane as a normal page target.
 */
function rewriteTargetInfoType<T extends { type?: string } | undefined>(
	info: T,
): T {
	if (!info) return info;
	if (info.type === "webview") {
		return { ...info, type: "page" } as T;
	}
	return info;
}

function shortSid(sid: string | undefined): string {
	if (!sid) return "(root)";
	return sid.slice(0, 8);
}

function shortTid(tid: string | undefined): string {
	if (!tid) return "?";
	return tid.slice(0, 8);
}

function summarizeParams(method: string, params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof p.url === "string") parts.push(`url=${p.url.slice(0, 60)}`);
	if (typeof p.targetId === "string") parts.push(`tid=${shortTid(p.targetId)}`);
	if (typeof p.sessionId === "string")
		parts.push(`sid=${shortSid(p.sessionId)}`);
	if (typeof p.expression === "string")
		parts.push(`js=${p.expression.slice(0, 40)}…`);
	if (typeof p.text === "string") parts.push(`text=${p.text.slice(0, 30)}`);
	if (typeof p.x === "number" && typeof p.y === "number")
		parts.push(`xy=${p.x},${p.y}`);
	if (typeof p.newWindow === "boolean") parts.push(`newWindow=${p.newWindow}`);
	if (typeof p.background === "boolean")
		parts.push(`background=${p.background}`);
	// Input/keyboard/focus diagnostics for the "keys leaked into the
	// Superset terminal pane" bug. Knowing whether the MCP sent the
	// event as root-scoped vs child-session-scoped is the key signal:
	// root-scoped Input.* targets whichever webContents currently
	// holds OS focus in the host BrowserWindow, which on a
	// multi-pane Superset window can be the xterm.js terminal pane
	// instead of the bound <webview>.
	if (method.startsWith("Input.")) {
		if (typeof p.type === "string") parts.push(`ev=${p.type}`);
		if (typeof p.key === "string") parts.push(`key=${p.key}`);
		if (typeof p.code === "string") parts.push(`code=${p.code}`);
		if (typeof p.windowsVirtualKeyCode === "number")
			parts.push(`vk=${p.windowsVirtualKeyCode}`);
		if (typeof p.button === "string") parts.push(`btn=${p.button}`);
	}
	void method;
	return parts.join(" ");
}

/**
 * Method names whose dispatch we want explicit, high-visibility
 * logging for. These are the CDP calls implicated in the reported
 * "MCP typed into the terminal pane instead of the browser" bug:
 * - Input.* delivers synthetic keyboard/mouse events. If sent on the
 *   root session (no `sessionId` / `msg.sessionId`) they hit the host
 *   BrowserWindow's focused webContents, which may be Superset's own
 *   terminal pane rather than the bound <webview>.
 * - Page.bringToFront / Target.activateTarget can pull OS focus over
 *   from the bound <webview> onto another webContents, setting up
 *   the focus-miss for the next Input.* call.
 * - DOM.focus / Runtime.evaluate("element.focus()") can have the
 *   same effect but are harder to detect; we log them at normal
 *   verbosity only.
 */
function isFocusAffectingMethod(method: string): boolean {
	return (
		method.startsWith("Input.") ||
		method === "Page.bringToFront" ||
		method === "Target.activateTarget" ||
		method === "Emulation.setFocusEmulationEnabled"
	);
}

let cdpConnSeq = 0;

export async function proxyBrowserUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
	chromiumPort: number,
	ctx: BoundContext,
): Promise<void> {
	cdpConnSeq += 1;
	const connId = cdpConnSeq;
	console.log(
		`[cdp #${connId}] proxyBrowserUpgrade pane=${ctx.paneId} primary=${shortTid(
			ctx.primaryTargetId,
		)} bound=${Array.from(ctx.boundTargetIds()).map(shortTid).join(",")}`,
	);
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
		// Track the targetId each admitted child session belongs to so
		// session-scoped methods (Page.bringToFront, Page.navigate, …)
		// can be routed back to a pane when UI bridging is needed.
		const sessionIdToTargetId = new Map<string, string>();
		// Allowed targetIds: starts as the bound set, but grows
		// transitively: any target whose `openerId` is already allowed
		// is admitted too. Without this, real children of the bound
		// page (popups, OOPIF iframes, dedicated/service workers
		// scoped to the page, prerender) are dropped at the root
		// filter even though clients legitimately need to interact
		// with them. childToParent lets us prune the closure when a
		// target is destroyed.
		const allowedTargetIds = new Set<string>(ctx.boundTargetIds());
		const childToParent = new Map<string, string>();
		// Internal requests the proxy issues (e.g. to proactively
		// attach to a newly-spawned secondary tab so Chromium emits
		// Target.attachedToTarget even when its own auto-attach logic
		// skips Electron <webview>-sourced targets). Responses with
		// these ids must NOT reach the client because it never knew
		// about them.
		const INTERNAL_REQ_BASE = 0x7fff_0000;
		let internalReqSeq = 0;
		const internalPendingIds = new Set<number>();
		// Timers for in-flight Target.createTarget waits; cleared on
		// WS close so a tardy renderer response can't leak timers /
		// resolve a dead connection.
		const pendingCreateTimers = new Set<NodeJS.Timeout>();
		const refreshBound = (): void => {
			for (const tid of ctx.boundTargetIds()) allowedTargetIds.add(tid);
		};
		const isAllowedTarget = (
			info: { targetId?: string; openerId?: string } | undefined,
			fallbackTargetId?: string,
		): boolean => {
			refreshBound();
			const tid = info?.targetId ?? fallbackTargetId;
			if (!tid) return false;
			if (allowedTargetIds.has(tid)) return true;
			const opener = info?.openerId;
			if (opener && allowedTargetIds.has(opener)) {
				allowedTargetIds.add(tid);
				childToParent.set(tid, opener);
				return true;
			}
			return false;
		};
		const dropTarget = (tid: string | undefined): void => {
			if (!tid) return;
			// Recursively drop descendants: childToParent maps child
			// targetId -> parent targetId, so any entry whose parent
			// is (transitively) tid should also be evicted. Without
			// this, popup/worker/prerender children of a closed tab
			// stay in allowedTargetIds forever, leaking scope
			// long-term on long-lived MCP connections.
			const queue: string[] = [tid];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const cur = queue.shift() as string;
				if (visited.has(cur)) continue;
				visited.add(cur);
				allowedTargetIds.delete(cur);
				for (const [child, parent] of childToParent) {
					if (parent === cur && !visited.has(child)) queue.push(child);
				}
				childToParent.delete(cur);
			}
			// Also clear any childToParent entry whose parent is now gone.
			for (const [child, parent] of Array.from(childToParent)) {
				if (visited.has(parent)) childToParent.delete(child);
			}
		};
		// Frames the client sends before Chromium's browser WS reaches
		// OPEN. CDP clients (puppeteer, cdp-use) typically fire
		// `Target.setDiscoverTargets` / `Target.setAutoAttach` the
		// instant our handshake completes, so dropping them would
		// deadlock `connect()`. `proxyPageUpgrade` buffers the same way.
		const pendingUpstream: unknown[] = [];
		if (ctx.onClose) ctx.onClose(clientWs);

		const closeBoth = (): void => {
			for (const t of pendingCreateTimers) clearTimeout(t);
			pendingCreateTimers.clear();
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
			if (upstream.readyState === WebSocket.CONNECTING) {
				pendingUpstream.push(obj);
				return;
			}
			if (upstream.readyState !== WebSocket.OPEN) return;
			try {
				upstream.send(JSON.stringify(obj));
			} catch {
				/* ignore */
			}
		};
		upstream.on("open", () => {
			for (const obj of pendingUpstream) {
				try {
					upstream.send(JSON.stringify(obj));
				} catch {
					/* ignore */
				}
			}
			pendingUpstream.length = 0;
		});
		// Use -32000 (server error) instead of -32601 (method not
		// found) so CDP clients (puppeteer / cdp-use) treat the
		// rejection as a normal protocol failure instead of falling
		// back to "method does not exist on this version of Chromium"
		// retry/normalization paths.
		const rejectRequest = (id: number, message: string): void => {
			sendToClient({ id, error: { code: -32000, message } });
		};

		clientWs.on("message", (data: RawData) => {
			let msg: JsonRpcMsg;
			try {
				msg = JSON.parse(data.toString()) as JsonRpcMsg;
			} catch {
				return;
			}
			const id = typeof msg.id === "number" ? msg.id : undefined;
			const method = msg.method ?? "";
			const summary = summarizeParams(method, msg.params);
			const paramsSid =
				typeof (msg.params as { sessionId?: unknown } | undefined)
					?.sessionId === "string"
					? ((msg.params as { sessionId?: string }).sessionId as string)
					: undefined;
			if (isFocusAffectingMethod(method)) {
				// High-visibility log line for focus/input-related calls.
				// We care specifically whether the MCP carried the event
				// on the webview's child session (msg.sessionId set, or
				// params.sessionId set for non-flatten paths) or on the
				// root session. Root-scoped Input.* is the smoking gun
				// for the terminal-leak bug.
				const scope = msg.sessionId
					? `child-flatten sid=${shortSid(msg.sessionId)}`
					: paramsSid
						? `child-params sid=${shortSid(paramsSid)}`
						: "ROOT";
				console.warn(
					`[cdp #${connId}] [focus/input] →up ${method} scope=${scope} id=${id ?? "-"}${summary ? ` ${summary}` : ""}`,
				);
			}
			if (msg.sessionId) {
				const allowed = allowedSessionIds.has(msg.sessionId);
				console.log(
					`[cdp #${connId}] →up sid=${shortSid(msg.sessionId)} id=${id ?? "-"} ${method}${summary ? ` ${summary}` : ""}${allowed ? "" : " [DROPPED unknown sid]"}`,
				);
				if (allowed) {
					// Session-scoped messages must still go through the
					// permission gate. Puppeteer / cdp-use send the
					// majority of page-domain commands (Debugger.*,
					// Network.*, Storage.*, DOMStorage.*, …) on a child
					// session, not the root session, so checking only
					// the root path would let permissive-gated methods
					// slip through under any preset — including the
					// "Secure" default. (Raised in CodeRabbit review on
					// PR #371.)
					const perm = checkMethodPermitted(
						method,
						permissionStore.getActiveToggles(),
					);
					if (!perm.allowed) {
						if (id !== undefined) {
							rejectRequest(
								id,
								perm.reason ??
									`${method} is not permitted by the Superset CDP filter`,
							);
						}
						return;
					}
					// Page.bringToFront is session-scoped; surface it as
					// a renderer-side tab activation so the tab bar
					// follows the MCP.
					if (method === "Page.bringToFront") {
						const tid = sessionIdToTargetId.get(msg.sessionId);
						if (tid) {
							const paneForTid = browserManager.getPaneIdForTarget(tid);
							if (paneForTid) {
								const tabId = browserManager.getTabIdForTarget(paneForTid, tid);
								browserManager.requestTabActivation(paneForTid, tabId);
							}
						}
					}
					// Electron quirk: session-scoped CDP Input.* events
					// SHOULD target the session's renderer, but on some
					// platforms Chromium delivers synthetic key/mouse
					// events to whichever widget currently holds
					// Chromium-internal focus. If the user clicked the
					// Superset terminal pane (xterm.js), the browser
					// pane's webContents has lost internal focus and
					// MCP keystrokes land in the terminal instead of
					// the page. Force-focus the bound webContents right
					// before forwarding Input.* so the synthetic events
					// hit the intended target.
					if (method.startsWith("Input.")) {
						const tid = sessionIdToTargetId.get(msg.sessionId);
						if (tid) {
							const paneForTid = browserManager.getPaneIdForTarget(tid);
							if (paneForTid) {
								const tabId = browserManager.getTabIdForTarget(paneForTid, tid);
								const wcId = browserManager.getWebContentsIdForTab(
									paneForTid,
									tabId,
								);
								if (wcId != null) {
									const wc = electronWebContents.fromId(wcId);
									try {
										wc?.focus();
									} catch {
										/* webContents may be gone */
									}
								}
							}
						}
					}
					sendToUpstream(msg);
				} else if (id !== undefined) {
					rejectRequest(
						id,
						"The supplied CDP sessionId is not authorized for this Superset session (the session may have been detached or belong to another pane).",
					);
				}
				return;
			}
			console.log(
				`[cdp #${connId}] →up (root) id=${id ?? "-"} ${method}${summary ? ` ${summary}` : ""}`,
			);
			refreshBound();
			// `bound` here is the dynamic allow-list (bound primary +
			// pane tab targets + transitively-admitted children of any
			// of those via openerId). Children are added by the
			// attachedToTarget event handler below; checking against
			// this set instead of the static ctx.boundTargetIds()
			// admits popups, OOPIF iframes, dedicated/service workers
			// scoped to the bound page, and prerender targets that
			// puppeteer / cdp-use legitimately need to drive.
			const bound = allowedTargetIds;

			// Permission check: consults the active preset's toggles.
			// Always-denied methods (Browser.close, Page.close, etc.)
			// are baked into permissions.ts; toggle-gated methods flip
			// with user-selected preset.
			const perm = checkMethodPermitted(
				method,
				permissionStore.getActiveToggles(),
			);
			if (!perm.allowed) {
				if (id !== undefined) {
					rejectRequest(
						id,
						perm.reason ??
							`${method} is not permitted by the Superset CDP filter`,
					);
				}
				return;
			}

			// Strip the `filter` field from Target.setAutoAttach AND
			// Target.setDiscoverTargets:
			// - puppeteer (chrome-devtools-mcp) sends setAutoAttach with
			//   `[{type:'page', exclude:true}]` waiting for a `tab`
			//   wrapper Electron does not expose, which would hang
			//   `connect()`.
			// - browser-use (cdp-use) sends setDiscoverTargets with
			//   `[{type:'page'}]`. Electron's <webview> is reported as
			//   `type:'webview'`, so the bound primary is excluded from
			//   discovery, Target.getTargets returns no matches, and
			//   browser-use's SessionManager errors with "Root CDP
			//   client not initialized" — the user-reported "セッション
			//   が切れている" symptom.
			// Removing the filter forces Chromium to surface every type;
			// our downstream Target event/result filter still scopes
			// the client's view to bound targetIds and rewrites
			// type=webview → page so puppeteer/cdp-use treat it as a
			// regular page.
			if (
				(method === "Target.setAutoAttach" ||
					method === "Target.setDiscoverTargets") &&
				id !== undefined
			) {
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
				// Bridge MCP-driven tab activation into the renderer
				// tab-bar so the user sees the same tab the MCP is
				// driving (matches Chrome's tab-strip-follows-CDP
				// behaviour). The renderer flips its activeTabId on
				// receipt of the activate-tab-requested event.
				if (tid) {
					const paneForTid = browserManager.getPaneIdForTarget(tid);
					if (paneForTid) {
						const tabId = browserManager.getTabIdForTarget(paneForTid, tid);
						browserManager.requestTabActivation(paneForTid, tabId);
					}
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
					| {
							url?: string;
							background?: boolean;
							newWindow?: boolean;
							browserContextId?: string;
							forTab?: boolean;
					  }
					| undefined;
				// Reject the browserContextId / newWindow / forTab
				// flavours: Superset doesn't expose multiple browser
				// contexts (incognito) and never opens its own OS
				// window for an MCP, so honouring those params would
				// silently lie to the client about what was created.
				// Tell the truth instead so puppeteer / playwright
				// surface a clean error.
				if (
					params?.browserContextId ||
					params?.newWindow === true ||
					params?.forTab !== undefined
				) {
					rejectRequest(
						id,
						"Target.createTarget with browserContextId / newWindow / forTab is not supported by the Superset CDP filter; tabs are always created inside the bound pane.",
					);
					return;
				}
				const nextUrl =
					typeof params?.url === "string" && params.url !== ""
						? params.url
						: "about:blank";
				// Allow only http(s) and about:blank by default. The
				// "privilegedSchemes" permission toggle lets the user
				// opt in to file://, chrome://, devtools://,
				// javascript:, data: — these either escape the pane
				// (privileged schemes) or let the client execute
				// arbitrary code with the bound origin's privileges.
				if (nextUrl !== "about:blank") {
					let parsed: URL | null = null;
					try {
						parsed = new URL(nextUrl);
					} catch {
						parsed = null;
					}
					const scheme = parsed?.protocol ?? "";
					const isSafeScheme = scheme === "http:" || scheme === "https:";
					if (
						!isSafeScheme &&
						!isPrivilegedSchemeAllowed(permissionStore.getActiveToggles())
					) {
						rejectRequest(
							id,
							`Target.createTarget url scheme ${scheme || "(invalid)"} requires the "privilegedSchemes" permission toggle.`,
						);
						return;
					}
				}
				// Tell the renderer to spawn a real new <webview> tab
				// for this pane. Wait for browser-manager to register
				// the new targetId (via addPaneTabTarget → tab-target-
				// added event) before responding, so the MCP gets the
				// new tab's id and not the primary's. Without this the
				// MCP attaches to whatever id we hand back and ends up
				// driving the wrong tab (the user-reported "新しいタブで
				// 検索すると最初のタブで検索される" behaviour).
				// Correlate this createTarget with the renderer reply
				// so concurrent createTarget calls (e.g. browser-use
				// and chrome-devtools-mcp opening tabs at the same
				// time) don't race each other onto the same new-tab
				// event.
				const requestId = `req-${connId}-${Date.now().toString(36)}-${id}`;
				const waitForNewTab = (): Promise<string | null> => {
					return new Promise((resolveTarget) => {
						const handler = (payload: {
							requestId?: string;
							targetId: string;
						}) => {
							if (payload.requestId !== requestId) return;
							browserManager.off(eventName, handler);
							clearTimeout(timer);
							pendingCreateTimers.delete(timer);
							console.log(
								`[cdp #${connId}] createTarget: new tab targetId=${shortTid(payload.targetId)} (req=${requestId})`,
							);
							resolveTarget(payload.targetId);
						};
						const eventName = `tab-target-added-for:${ctx.paneId}`;
						browserManager.on(eventName, handler);
						const timer = setTimeout(() => {
							browserManager.off(eventName, handler);
							pendingCreateTimers.delete(timer);
							console.warn(
								`[cdp #${connId}] createTarget: TIMEOUT waiting for new tab req=${requestId}`,
							);
							// Surface a real error rather than silently
							// falling back to the primary targetId. A
							// fallback makes the client think a new tab
							// was created and then drive the primary,
							// which looks like "the MCP opened a tab
							// but then searched in the old one".
							resolveTarget(null);
						}, 8000);
						pendingCreateTimers.add(timer);
					});
				};
				console.log(
					`[cdp #${connId}] createTarget: spawning new tab url=${nextUrl} req=${requestId}`,
				);
				try {
					console.log(
						`[tab-diag] createTarget→emit pane=${ctx.paneId} url=${nextUrl} req=${requestId} bg=${params?.background === true}`,
					);
					browserManager.emit(`create-tab-requested:${ctx.paneId}`, {
						url: nextUrl,
						requestId,
						background: params?.background === true,
					});
				} catch {
					/* best effort */
				}
				void waitForNewTab().then((newTargetId) => {
					if (!newTargetId) {
						rejectRequest(
							id,
							"Target.createTarget timed out waiting for the renderer to spawn a new tab.",
						);
						return;
					}
					console.log(
						`[cdp #${connId}] createTarget: responding id=${id} targetId=${shortTid(newTargetId)}`,
					);
					// Admit the new tab into the scope so subsequent
					// events (attachedToTarget, targetInfoChanged,
					// Page.frameNavigated, …) survive the root filter.
					allowedTargetIds.add(newTargetId);
					childToParent.set(newTargetId, ctx.primaryTargetId);
					sendToClient({ id, result: { targetId: newTargetId } });
					// Chromium's auto-attach does not fire for Electron
					// <webview> targets we just created via the renderer
					// side-channel, so puppeteer's newPage() would hang
					// forever waiting for Target.attachedToTarget.
					// Proactively attach here (via an internal id the
					// client will never see a response for) so Chromium
					// emits the attachedToTarget event that our filter
					// then forwards to the client as if auto-attach had
					// produced it.
					internalReqSeq += 1;
					const internalId = INTERNAL_REQ_BASE + internalReqSeq;
					internalPendingIds.add(internalId);
					sendToUpstream({
						id: internalId,
						method: "Target.attachToTarget",
						params: { targetId: newTargetId, flatten: true },
					});
				});
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
				const tid = targetIdOf(msg.params);
				if ((sid && !allowedSessionIds.has(sid)) || (tid && !bound.has(tid))) {
					rejectRequest(
						id,
						"Target.detachFromTarget outside the bound scope is refused by the Superset CDP filter.",
					);
					return;
				}
				pendingMethods.set(id, method);
				sendToUpstream(msg);
				return;
			}

			// Remaining Target.* methods that address a specific target or
			// session (e.g. sendMessageToTarget, setRemoteLocations). Verify
			// any supplied targetId / sessionId are inside scope before
			// forwarding.
			if (method.startsWith("Target.") && id !== undefined) {
				const tid = targetIdOf(msg.params);
				const sid = (msg.params as { sessionId?: string } | undefined)
					?.sessionId;
				if (tid && !bound.has(tid)) {
					rejectRequest(id, `${method} targetId is outside the bound scope.`);
					return;
				}
				if (sid && !allowedSessionIds.has(sid)) {
					rejectRequest(
						id,
						`${method} sessionId is not authorized for this Superset session.`,
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
			refreshBound();
			// `bound` here is the dynamic allow-list (bound primary +
			// pane tab targets + transitively-admitted children of any
			// of those via openerId). Children are added by the
			// attachedToTarget event handler below; checking against
			// this set instead of the static ctx.boundTargetIds()
			// admits popups, OOPIF iframes, dedicated/service workers
			// scoped to the bound page, and prerender targets that
			// puppeteer / cdp-use legitimately need to drive.
			const bound = allowedTargetIds;
			const summary = summarizeParams(msg.method ?? "", msg.params);

			if (msg.sessionId) {
				if (!allowedSessionIds.has(msg.sessionId)) {
					console.log(
						`[cdp #${connId}] ←dn sid=${shortSid(msg.sessionId)} ${msg.method ?? "?"} [DROPPED unknown sid]`,
					);
					return;
				}
				console.log(
					`[cdp #${connId}] ←dn sid=${shortSid(msg.sessionId)} id=${msg.id ?? "-"} ${msg.method ?? "(response)"}${summary ? ` ${summary}` : ""}`,
				);
				if (msg.method === "Target.attachedToTarget") {
					// Nested attach (worker / iframe / prerender of a
					// target the parent session already owns). Trust
					// the parent: admit both the child sessionId AND
					// the child targetId via openerId so subsequent
					// session-scoped frames + root events reach the
					// client cleanly.
					const params = msg.params as
						| {
								sessionId?: string;
								targetInfo?: { targetId?: string; openerId?: string };
						  }
						| undefined;
					const childSid = params?.sessionId;
					if (childSid) allowedSessionIds.add(childSid);
					const childTid = params?.targetInfo?.targetId;
					if (childTid) {
						allowedTargetIds.add(childTid);
						const opener = params?.targetInfo?.openerId;
						if (opener) childToParent.set(childTid, opener);
					}
				} else if (msg.method === "Target.detachedFromTarget") {
					const params = msg.params as
						| { sessionId?: string; targetId?: string }
						| undefined;
					const childSid = params?.sessionId;
					if (childSid) allowedSessionIds.delete(childSid);
					const childTid = params?.targetId;
					if (childTid) dropTarget(childTid);
				}
				sendToClient(msg);
				return;
			}

			if (typeof msg.id === "number") {
				if (internalPendingIds.has(msg.id)) {
					internalPendingIds.delete(msg.id);
					// Proactive Target.attachToTarget reply. The
					// resulting Target.attachedToTarget event has
					// already been delivered separately and is what
					// the client actually cares about; swallow the
					// response to avoid forwarding an id the client
					// never issued.
					const sid = (msg.result as { sessionId?: string } | undefined)
						?.sessionId;
					if (sid) allowedSessionIds.add(sid);
					console.log(
						`[cdp #${connId}] internal attach response id=${msg.id} sid=${shortSid(sid)} consumed`,
					);
					return;
				}
				const origMethod = pendingMethods.get(msg.id);
				pendingMethods.delete(msg.id);
				console.log(
					`[cdp #${connId}] ←dn (root) id=${msg.id} response-to=${origMethod ?? "?"}${msg.error ? ` ERROR=${msg.error.message}` : ""}`,
				);
				if (origMethod === "Target.getTargets" && msg.result) {
					const infos = (msg.result.targetInfos ?? []) as Array<
						{ type?: string } & Record<string, unknown>
					>;
					const filtered = infos
						.filter((i) => {
							const tid = targetIdOf(i);
							return tid !== undefined && bound.has(tid);
						})
						.map((i) => rewriteTargetInfoType(i));
					console.log(
						"[cdp-filter-proxy] Target.getTargets upstream returned",
						infos.length,
						"infos | bound set",
						Array.from(bound),
						"| filtered to",
						filtered.length,
						"| upstream ids:",
						infos.map((i) => `${i.type}:${targetIdOf(i)}`),
					);
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
					sendToClient({
						...msg,
						result: {
							...msg.result,
							targetInfo: rewriteTargetInfoType(
								msg.result.targetInfo as { type?: string },
							),
						},
					});
					return;
				}
				sendToClient(msg);
				return;
			}

			const method = msg.method ?? "";
			if (
				method === "Target.targetCreated" ||
				method === "Target.targetInfoChanged"
			) {
				// Admit the target if it is in scope OR if its
				// `openerId` is in scope (popups, child pages, etc.).
				const params = msg.params as
					| {
							targetInfo?: {
								type?: string;
								targetId?: string;
								openerId?: string;
								attached?: boolean;
							};
							targetId?: string;
					  }
					| undefined;
				const info = params?.targetInfo;
				const allowed = isAllowedTarget(info, params?.targetId);
				const tid = info?.targetId ?? params?.targetId;
				if (!allowed) {
					console.log(
						`[cdp #${connId}] ←dn (root) ${method} tid=${shortTid(tid)} [DROPPED not in bound]`,
					);
					return;
				}
				console.log(
					`[cdp #${connId}] ←dn (root) ${method} tid=${shortTid(tid)} type=${info?.type ?? "?"}`,
				);
				// Chromium's own auto-attach logic can miss Electron-
				// hosted targets (webview-derived pages, Service
				// Workers / Shared Workers / Dedicated Workers scoped
				// to the bound page, popup windows, prerender targets)
				// — puppeteer and playwright both only materialise
				// Page / Worker / ServiceWorker objects from
				// attachedToTarget, so a target that is merely
				// announced via targetCreated but never attached stays
				// invisible to the MCP. Proactively attach any
				// newly-created target whose type is one of the
				// relevant kinds and which we have not already
				// attached to. Chromium emits the real
				// attachedToTarget that our filter then forwards.
				const t = info?.type;
				if (
					method === "Target.targetCreated" &&
					tid &&
					info?.attached !== true &&
					(t === "page" ||
						t === "iframe" ||
						t === "service_worker" ||
						t === "shared_worker" ||
						t === "worker" ||
						t === "prerender" ||
						t === "webview")
				) {
					internalReqSeq += 1;
					const internalId = INTERNAL_REQ_BASE + internalReqSeq;
					internalPendingIds.add(internalId);
					console.log(
						`[cdp #${connId}] proactive attach tid=${shortTid(tid)} type=${t} internalId=${internalId}`,
					);
					sendToUpstream({
						id: internalId,
						method: "Target.attachToTarget",
						params: { targetId: tid, flatten: true },
					});
				}
				if (info) {
					sendToClient({
						...msg,
						params: {
							...params,
							targetInfo: rewriteTargetInfoType(info),
						},
					});
				} else {
					sendToClient(msg);
				}
				return;
			}
			if (
				method === "Target.targetDestroyed" ||
				method === "Target.targetCrashed"
			) {
				const params = msg.params as
					| {
							targetInfo?: { type?: string; targetId?: string };
							targetId?: string;
					  }
					| undefined;
				const info = params?.targetInfo;
				const tid = info?.targetId ?? params?.targetId;
				if (!tid || !bound.has(tid)) {
					console.log(
						`[cdp #${connId}] ←dn (root) ${method} tid=${shortTid(tid)} [DROPPED not in bound]`,
					);
					return;
				}
				console.log(
					`[cdp #${connId}] ←dn (root) ${method} tid=${shortTid(tid)} type=${info?.type ?? "?"}`,
				);
				dropTarget(tid);
				if (info) {
					sendToClient({
						...msg,
						params: {
							...params,
							targetInfo: rewriteTargetInfoType(info),
						},
					});
				} else {
					sendToClient(msg);
				}
				return;
			}
			if (method === "Target.attachedToTarget") {
				const params = msg.params as
					| {
							sessionId?: string;
							targetInfo?: {
								type?: string;
								targetId?: string;
								openerId?: string;
							};
					  }
					| undefined;
				const allowed = isAllowedTarget(params?.targetInfo);
				const tid = params?.targetInfo?.targetId;
				if (!allowed) {
					console.log(
						`[cdp #${connId}] ←dn (root) attachedToTarget tid=${shortTid(tid)} [DROPPED not in bound]`,
					);
					return;
				}
				if (params?.sessionId) allowedSessionIds.add(params.sessionId);
				if (params?.sessionId && tid) {
					sessionIdToTargetId.set(params.sessionId, tid);
				}
				console.log(
					`[cdp #${connId}] ←dn (root) attachedToTarget tid=${shortTid(tid)} sid=${shortSid(params?.sessionId)} (allowed=${allowedSessionIds.size})`,
				);
				sendToClient({
					...msg,
					params: {
						...(params ?? {}),
						targetInfo: rewriteTargetInfoType(params?.targetInfo),
					},
				});
				return;
			}
			if (method === "Target.detachedFromTarget") {
				const sid = (msg.params as { sessionId?: string } | undefined)
					?.sessionId;
				if (!sid || !allowedSessionIds.has(sid)) return;
				allowedSessionIds.delete(sid);
				console.log(
					`[cdp #${connId}] ←dn (root) detachedFromTarget sid=${shortSid(sid)} (allowed=${allowedSessionIds.size})`,
				);
				sendToClient(msg);
				return;
			}
			// Target.receivedMessageFromTarget carries a session-scoped
			// payload on the browser-level socket (the non-flatten path).
			// Drop it when the inner sessionId or targetId is outside our
			// scope so we don't leak another pane's CDP traffic.
			if (method === "Target.receivedMessageFromTarget") {
				const params = msg.params as
					| { sessionId?: string; targetId?: string }
					| undefined;
				if (params?.sessionId && !allowedSessionIds.has(params.sessionId))
					return;
				if (params?.targetId && !bound.has(params.targetId)) return;
				sendToClient(msg);
				return;
			}
			// Any other Target.* event that mentions a targetId /
			// sessionId must also be scoped.
			if (method.startsWith("Target.")) {
				const tid =
					targetIdOf(msg.params) ??
					(msg.params as { targetInfo?: { targetId?: string } } | undefined)
						?.targetInfo?.targetId;
				const sid = (msg.params as { sessionId?: string } | undefined)
					?.sessionId;
				if (tid && !bound.has(tid)) return;
				if (sid && !allowedSessionIds.has(sid)) return;
				sendToClient(msg);
				return;
			}
			sendToClient(msg);
		});

		upstream.on("error", (err) => {
			console.warn("[cdp-filter-proxy] browser upstream error", err);
			closeBoth();
		});
		upstream.on("close", (code, reason) => {
			console.log(
				"[cdp-filter-proxy] upstream WS closed",
				code,
				reason?.toString?.() ?? "",
			);
			closeBoth();
		});
		clientWs.on("error", (err) => {
			console.warn("[cdp-filter-proxy] client WS error", err);
			closeBoth();
		});
		clientWs.on("close", (code, reason) => {
			console.log(
				"[cdp-filter-proxy] client WS closed",
				code,
				reason?.toString?.() ?? "",
			);
			closeBoth();
		});
	});
}
