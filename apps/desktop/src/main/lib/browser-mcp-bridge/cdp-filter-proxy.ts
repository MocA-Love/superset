import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, type WebSocketServer } from "ws";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
import { resolveCdpPort } from "./cdp-port";

/**
 * CDP (Chrome DevTools Protocol) filter proxy.
 *
 * External browser automation MCPs (chrome-devtools-mcp / browser-use /
 * playwright-mcp / …) speak CDP over HTTP + WebSocket. Chromium exposes
 * every page target on its loopback debugging port, which would leak
 * sibling Superset panes / devtools / the workspace shell to whichever
 * LLM is attached.
 *
 * This proxy sits in front of Chromium and presents only the bound
 * pane as if it were the sole browser target, keyed by a short-lived
 * per-session token in the URL. The upstream Chromium target the
 * proxy forwards to is resolved at request time from the current
 * session -> pane binding, so hot-swapping the binding in the UI
 * reroutes the same filtered endpoint without the external client
 * needing to reconnect (for HTTP) or noticing the switch beyond a
 * single socket reset (for WebSocket).
 */

const TOKEN_BYTES = 24;
const TOKEN_STORE_PATH = join(SUPERSET_HOME_DIR, "browser-mcp-tokens.json");

interface TokenEntry {
	sessionId: string;
	createdAt: number;
	lastUsedAt: number;
}

const tokensBySession = new Map<string, string>();
const entriesByToken = new Map<string, TokenEntry>();
let hydrated = false;

interface PersistedTokenFile {
	version: 1;
	entries: Array<TokenEntry & { token: string }>;
}

/**
 * Load previously-minted tokens from disk. Tokens survive app
 * restarts so the URL a user registered once into their external
 * browser MCP (chrome-devtools-mcp / browser-use) stays valid.
 */
function hydrate(): void {
	if (hydrated) return;
	hydrated = true;
	try {
		const raw = readFileSync(TOKEN_STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<PersistedTokenFile>;
		if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return;
		for (const e of parsed.entries) {
			if (
				typeof e.token === "string" &&
				e.token.length >= TOKEN_BYTES * 2 &&
				typeof e.sessionId === "string"
			) {
				tokensBySession.set(e.sessionId, e.token);
				entriesByToken.set(e.token, {
					sessionId: e.sessionId,
					createdAt: e.createdAt ?? Date.now(),
					lastUsedAt: e.lastUsedAt ?? Date.now(),
				});
			}
		}
	} catch {
		/* no prior state, start fresh */
	}
}

function persist(): void {
	try {
		const payload: PersistedTokenFile = {
			version: 1,
			entries: Array.from(entriesByToken.entries()).map(([token, entry]) => ({
				token,
				...entry,
			})),
		};
		mkdirSync(dirname(TOKEN_STORE_PATH), { recursive: true });
		writeFileSync(TOKEN_STORE_PATH, JSON.stringify(payload, null, 2), {
			mode: 0o600,
		});
		// writeFileSync's `mode` only applies to new files. If the file
		// already existed with broader permissions (backup/restore, etc.)
		// we still need to tighten it so long-lived /cdp/<token>
		// credentials never leak to other local users.
		try {
			chmodSync(TOKEN_STORE_PATH, 0o600);
		} catch {
			/* best-effort */
		}
	} catch (error) {
		console.warn("[cdp-filter-proxy] failed to persist tokens:", error);
	}
}

export function mintCdpToken(sessionId: string): string {
	hydrate();
	const existing = tokensBySession.get(sessionId);
	if (existing) {
		const entry = entriesByToken.get(existing);
		if (entry) entry.lastUsedAt = Date.now();
		return existing;
	}
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	tokensBySession.set(sessionId, token);
	entriesByToken.set(token, {
		sessionId,
		createdAt: Date.now(),
		lastUsedAt: Date.now(),
	});
	persist();
	return token;
}

function resolveTokenToPane(
	token: string,
): { sessionId: string; paneId: string; targetId: string } | null {
	hydrate();
	const entry = entriesByToken.get(token);
	if (!entry) return null;
	entry.lastUsedAt = Date.now();
	const binding = bindingStore.getBySessionId(entry.sessionId);
	if (!binding) return null;
	const targetId = browserManager.getCdpTargetId(binding.paneId);
	if (!targetId) return null;
	return { sessionId: entry.sessionId, paneId: binding.paneId, targetId };
}

const CDP_PATH_PATTERN =
	/^\/cdp\/([0-9a-f]{32,})(\/json(?:\/version|\/list|\/protocol)?|\/devtools\/page\/[^/]+)?$/;

interface ParsedPath {
	token: string;
	subPath: string;
}

function parseCdpPath(pathname: string): ParsedPath | null {
	const match = pathname.match(CDP_PATH_PATTERN);
	if (!match) return null;
	return { token: match[1], subPath: match[2] ?? "" };
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

/**
 * Return true if the request was fully handled here; false otherwise
 * so the outer bridge can fall through to its own routes.
 */
export async function handleCdpHttp(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	const parsed = parseCdpPath(pathname);
	if (!parsed) return false;
	const resolved = resolveTokenToPane(parsed.token);
	if (!resolved) {
		sendJson(res, 404, {
			error:
				"Unknown or expired CDP token, or no pane is bound to the session.",
		});
		return true;
	}

	try {
		if (parsed.subPath === "/json/version") {
			const body = (await fetchUpstreamJson("/json/version")) as Record<
				string,
				unknown
			>;
			// Chromium's /json/version response carries the browser-level
			// `webSocketDebuggerUrl` for the root CDP target. Leaving it in
			// would let a caller with a valid /cdp/<token> URL bypass the
			// per-pane filter entirely by attaching straight to
			// ws://127.0.0.1:<raw>/devtools/browser/... . Strip it so the
			// only ws path the caller ever sees is the token-scoped one.
			const { webSocketDebuggerUrl: _unused, ...safe } = body;
			void _unused;
			sendJson(res, 200, safe);
			return true;
		}
		if (parsed.subPath === "/json/protocol") {
			const body = await fetchUpstreamJson("/json/protocol");
			sendJson(res, 200, body);
			return true;
		}
		if (parsed.subPath === "/json" || parsed.subPath === "/json/list") {
			// Return the bound pane as the only visible target.
			const port = await resolveCdpPort();
			if (!port) throw new Error("Chromium CDP port not available");
			const rawList = (await fetchUpstreamJson("/json/list")) as Array<
				Record<string, unknown>
			>;
			const filtered = rawList.filter(
				(item) => (item as { id?: string }).id === resolved.targetId,
			);
			// Rewrite ws/frontend URLs so callers see the token-scoped path
			// and never call Chromium directly.
			const host = req.headers.host ?? "127.0.0.1";
			const rewritten = filtered.map((item) => {
				const out = { ...item };
				const id = resolved.targetId;
				out.webSocketDebuggerUrl = `ws://${host}/cdp/${parsed.token}/devtools/page/${id}`;
				out.devtoolsFrontendUrl = `http://${host}/cdp/${parsed.token}/devtools/page/${id}`;
				return out;
			});
			sendJson(res, 200, rewritten);
			return true;
		}
		// /devtools/page/<id> accessed via plain HTTP — not valid CDP, the
		// upgrade handler deals with the WebSocket case.
		sendJson(res, 404, { error: "not found" });
		return true;
	} catch (error) {
		sendJson(res, 502, {
			error: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}

/**
 * Return true if the upgrade request targets the CDP proxy and was
 * consumed. The caller only needs to wire `server.on('upgrade', ...)`
 * once and let us decide.
 */
export async function handleCdpUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	wss: WebSocketServer,
): Promise<boolean> {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	const parsed = parseCdpPath(pathname);
	if (!parsed) return false;
	if (!parsed.subPath.startsWith("/devtools/page/")) {
		socket.destroy();
		return true;
	}
	const resolved = resolveTokenToPane(parsed.token);
	if (!resolved) {
		socket.destroy();
		return true;
	}
	const port = await resolveCdpPort();
	if (!port) {
		socket.destroy();
		return true;
	}
	wss.handleUpgrade(req, socket, head, (clientWs) => {
		const upstreamUrl = `ws://127.0.0.1:${port}/devtools/page/${resolved.targetId}`;
		const upstream = new WebSocket(upstreamUrl);
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
		// CDP clients typically ship their first command immediately after
		// the handshake, so wire the client handler BEFORE upstream opens
		// and buffer frames until upstream is ready. Otherwise early frames
		// get dropped and the attach looks stalled.
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
	return true;
}
