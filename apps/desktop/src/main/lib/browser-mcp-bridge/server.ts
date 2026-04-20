import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { app } from "electron";
import { WebSocketServer } from "ws";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
import {
	handleCdpHttp,
	handleCdpUpgrade,
	mintCdpToken,
} from "./cdp-filter-proxy";
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

			// CDP filter proxy paths authenticate via an unguessable URL
			// token, so they skip the Bearer header external browser MCPs
			// (chrome-devtools-mcp / browser-use / playwright-mcp) cannot
			// easily be taught to send.
			if (url.pathname.startsWith("/cdp/")) {
				const handled = await handleCdpHttp(req, res);
				if (handled) return;
				return send(res, 404, { error: "not found" });
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
				const token = mintCdpToken(resolved.sessionId);
				const bridgePort = port;
				return send(res, 200, {
					paneId: resolved.paneId,
					sessionId: resolved.sessionId,
					targetId,
					cdpPort,
					// The filter proxy runs on the bridge port (loopback) and
					// masks every other Chromium target, so external browser
					// MCPs only ever see the pane bound to this session.
					httpBase: `http://127.0.0.1:${bridgePort}/cdp/${token}`,
					webSocketDebuggerUrl: `ws://127.0.0.1:${bridgePort}/cdp/${token}/devtools/page/${targetId}`,
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

	// Standalone WebSocketServer (noServer) that the upgrade handler
	// pipes client sockets into once it has resolved the /cdp/<token>/…
	// path. Outgoing frames flow to an upstream Chromium WS managed by
	// cdp-filter-proxy.
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const remote = req.socket.remoteAddress ?? "";
		if (
			remote !== "127.0.0.1" &&
			remote !== "::1" &&
			remote !== "::ffff:127.0.0.1"
		) {
			socket.destroy();
			return;
		}
		void handleCdpUpgrade(req, socket, head, wss).then((handled) => {
			if (!handled) socket.destroy();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("browser-mcp-bridge: failed to bind port");
	}
	const port = address.port;

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
