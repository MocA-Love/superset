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
import { SUPERSET_HOME_DIR } from "../app-environment";
import { browserManager } from "../browser/browser-manager";
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

const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

class PayloadTooLargeError extends Error {
	readonly status = 413;
	constructor() {
		super(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
	}
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

async function _readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError();
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? (JSON.parse(raw) as T) : ({} as T);
}
// Kept for follow-up endpoints that accept bodies; silences unused hint.
void _readJson;

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
			// Require loopback + shared secret.
			const remote = req.socket.remoteAddress ?? "";
			if (
				remote !== "127.0.0.1" &&
				remote !== "::1" &&
				remote !== "::ffff:127.0.0.1"
			) {
				return send(res, 403, { error: "loopback only" });
			}
			const auth = req.headers.authorization ?? "";
			if (auth !== `Bearer ${secret}`) {
				return send(res, 401, { error: "bad token" });
			}

			const url = new URL(req.url ?? "/", "http://localhost");

			if (req.method === "POST" && url.pathname === "/mcp/register") {
				return send(res, 200, { ok: true });
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
			if (error instanceof PayloadTooLargeError) {
				return send(res, 413, { error: error.message });
			}
			console.error("[browser-mcp-bridge]", error);
			return send(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
