import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { app } from "electron";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
import {
	ensureGlobalBrowserUseConfig,
	handleCdpGatewayRequest,
	handleCdpGatewayUpgrade,
	isCdpGatewayPath,
	isCdpGatewayUpgradePath,
} from "./cdp-gateway";
import { resolveCdpPort } from "./cdp-port";
import { getBoundPaneForSession, resolvePpidToSession } from "./pane-resolver";

/**
 * HTTP bridge between the `packages/superset-browser-mcp` MCP server and
 * this Electron app. The MCP discovers the app via a runtime info file at
 * `${SUPERSET_HOME_DIR}/browser-mcp.json` (workspace-scoped) — this lets
 * multiple Superset instances with different `SUPERSET_WORKSPACE_NAME`
 * values coexist without overwriting each other's port/secret.
 *
 * Scope of this bridge is intentionally small: the MCP only needs to
 * resolve its PPID → Superset LLM session → bound paneId → metadata
 * about that pane. Actual browser automation (click / navigate / DOM
 * inspection / screenshot) is delegated to external browser MCPs via
 * the per-pane filtered CDP endpoint (see ./plan.md in the repo root).
 * This file should stay small; if you are about to add tool-like
 * endpoints here, you're fighting the plan.
 */

const RUNTIME_INFO_PATH = join(SUPERSET_HOME_DIR, "browser-mcp.json");

/**
 * Preferred loopback port for the bridge. Chosen in the IANA
 * dynamic-port range where browser dev tools are unlikely to collide
 * (9000-series is taken by Chrome remote debugging, 3000/5173 by dev
 * servers, 8080 by everything, etc.). Persisted to browser-mcp.json so
 * the same port is reused on restart — which lets the CDP URL that an
 * external MCP was registered with stay valid across Superset launches.
 */
const PREFERRED_BRIDGE_PORT = 47834;

async function tryListen(server: Server, port: number): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		const onError = (err: NodeJS.ErrnoException): void => {
			server.off("error", onError);
			if (err.code === "EADDRINUSE") resolve(null);
			else resolve(null);
		};
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			const address = server.address();
			if (!address || typeof address === "string") {
				resolve(null);
				return;
			}
			resolve(address.port);
		});
	});
}

function readPersistedPort(): number | null {
	try {
		const raw = readFileSync(RUNTIME_INFO_PATH, "utf8");
		const parsed = JSON.parse(raw) as { port?: number };
		if (
			typeof parsed.port === "number" &&
			Number.isInteger(parsed.port) &&
			parsed.port > 0 &&
			parsed.port < 65_536
		) {
			return parsed.port;
		}
	} catch {
		/* no prior state */
	}
	return null;
}

async function listenPreferringStablePort(server: Server): Promise<number> {
	// The gateway URL is now always http://127.0.0.1:47834, so prefer
	// that first even if an older build persisted a different port in
	// browser-mcp.json (e.g. 49939 from the per-session port era). Only
	// fall back to the persisted value if 47834 is taken, then to a
	// kernel-assigned port.
	const previous = readPersistedPort();
	const candidates = [PREFERRED_BRIDGE_PORT, previous].filter(
		(p, i, arr): p is number => typeof p === "number" && arr.indexOf(p) === i,
	);
	for (const candidate of candidates) {
		const bound = await tryListen(server, candidate);
		if (bound) return bound;
	}
	const bound = await tryListen(server, 0);
	if (bound) return bound;
	throw new Error("browser-mcp-bridge: could not bind any loopback port");
}

async function resolvePaneFromRequest(
	req: IncomingMessage,
): Promise<
	{ paneId: string; sessionId: string } | { error: string; status: number }
> {
	const ppidHeader = req.headers["x-superset-mcp-ppid"];
	const ppid =
		typeof ppidHeader === "string" ? Number.parseInt(ppidHeader, 10) : NaN;
	if (!Number.isFinite(ppid) || ppid <= 0) {
		return { error: "missing x-superset-mcp-ppid header", status: 400 };
	}
	const resolved = await resolvePpidToSession(ppid);
	if (!resolved) {
		return {
			error:
				"Could not map this MCP to a Superset LLM session. Make sure Claude / Codex is running inside a Superset terminal pane.",
			status: 404,
		};
	}
	const paneId = getBoundPaneForSession(resolved.sessionId);
	if (!paneId) {
		return {
			error: `No browser pane is bound to session ${resolved.sessionId}. Open the Connect dialog in the Superset UI to pick one.`,
			status: 409,
		};
	}
	return { paneId, sessionId: resolved.sessionId };
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

interface BridgeHandle {
	port: number;
	secret: string;
	stop: () => Promise<void>;
}

let current: BridgeHandle | null = null;

export function getBrowserMcpBridge(): BridgeHandle | null {
	return current;
}

export async function startBrowserMcpBridge(): Promise<BridgeHandle> {
	if (current) return current;
	const secret = randomBytes(24).toString("hex");

	const server: Server = createServer(async (req, res) => {
		try {
			// Require loopback for every route.
			const remote = req.socket.remoteAddress ?? "";
			if (
				remote !== "127.0.0.1" &&
				remote !== "::1" &&
				remote !== "::ffff:127.0.0.1"
			) {
				return send(res, 403, { error: "loopback only" });
			}

			const url = new URL(req.url ?? "/", "http://localhost");

			// CDP gateway routes are unauthenticated (external CDP MCPs
			// compose URLs that drop the path, so no secret can survive).
			// Their capability is the peer-PID tree-descendant check.
			if (isCdpGatewayPath(url.pathname)) {
				return handleCdpGatewayRequest(req, res);
			}

			const auth = req.headers.authorization ?? "";
			if (auth !== `Bearer ${secret}`) {
				return send(res, 401, { error: "bad token" });
			}

			if (req.method === "POST" && url.pathname === "/mcp/register") {
				return send(res, 200, { ok: true });
			}

			if (req.method === "GET" && url.pathname === "/mcp/cdp-endpoint") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved)
					return send(res, resolved.status, { error: resolved.error });
				const targetId = browserManager.getCdpTargetId(resolved.paneId);
				if (!targetId) {
					return send(res, 503, {
						error:
							"CDP targetId for this pane has not been captured yet. Give the pane a moment to finish loading and retry.",
					});
				}
				const cdpPort = await resolveCdpPort();
				if (!cdpPort) {
					return send(res, 503, {
						error:
							"Chromium CDP port is not available. This build did not start with --remote-debugging-port.",
					});
				}
				const wc = browserManager.getWebContents(resolved.paneId);
				// Since M1 the CDP data plane lives on this same bridge
				// port (47834); the gateway routes each incoming
				// connection by peer-PID. One stable URL works for every
				// session and survives restarts / rebindings.
				const gatewayPort = await import("./server").then(
					(m) => m.getBrowserMcpBridge()?.port ?? port,
				);
				return send(res, 200, {
					paneId: resolved.paneId,
					sessionId: resolved.sessionId,
					targetId,
					cdpPort,
					httpBase: `http://127.0.0.1:${gatewayPort}`,
					webSocketDebuggerUrl: `ws://127.0.0.1:${gatewayPort}/devtools/page/${targetId}`,
					url: wc?.getURL() ?? null,
					title: wc?.getTitle() ?? null,
					filtered: true,
				});
			}

			if (req.method === "GET" && url.pathname === "/mcp/binding") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved) {
					return send(res, 200, {
						bound: false,
						paneId: null,
						sessionId: null,
						url: null,
						title: null,
						reason: resolved.error,
					});
				}
				const wc = browserManager.getWebContents(resolved.paneId);
				return send(res, 200, {
					bound: true,
					paneId: resolved.paneId,
					sessionId: resolved.sessionId,
					url: wc?.getURL() ?? null,
					title: wc?.getTitle() ?? null,
				});
			}

			return send(res, 404, { error: "not found" });
		} catch (error) {
			console.error("[browser-mcp-bridge]", error);
			return send(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// CDP gateway WS upgrades land on /devtools/browser/<id> and
	// /devtools/page/<id>. Route them to the gateway before the default
	// socket.destroy() path kicks in.
	server.on("upgrade", (req, socket, head) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (isCdpGatewayUpgradePath(pathname)) {
			void handleCdpGatewayUpgrade(req, socket, head);
			return;
		}
		socket.destroy();
	});

	const port = await listenPreferringStablePort(server);

	// One-shot: write the global browser-use config pointing at this
	// gateway. Same file for every session; session routing happens
	// per connection via peer-PID.
	ensureGlobalBrowserUseConfig(port);

	mkdirSync(dirname(RUNTIME_INFO_PATH), { recursive: true });
	writeFileSync(RUNTIME_INFO_PATH, JSON.stringify({ port, secret }, null, 2), {
		mode: 0o600,
	});
	// writeFileSync's mode only applies to new files — an existing
	// runtime file from a previous run could still be world-readable.
	// Force 0600 on every start so the shared secret stays locked down.
	try {
		chmodSync(RUNTIME_INFO_PATH, 0o600);
	} catch {
		/* best-effort */
	}

	app.on("will-quit", () => {
		server.close();
	});

	current = {
		port,
		secret,
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
	console.log(`[browser-mcp-bridge] listening on 127.0.0.1:${port}`);
	return current;
}
