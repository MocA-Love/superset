import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
 * Requests carry the MCP process's PPID in `x-superset-mcp-ppid`. We use
 * that to resolve the LLM session and then the bound paneId on every call,
 * so the user-visible flow is "set up MCP once, then bind panes in the
 * UI — the MCP follows whatever pane is currently bound".
 */

const RUNTIME_INFO_PATH = join(SUPERSET_HOME_DIR, "browser-mcp.json");
const CONSOLE_BUFFER_LIMIT = 500;

interface ConsoleEntry {
	level: string;
	message: string;
	at: number;
}

const consoleByPane = new Map<string, ConsoleEntry[]>();
const attachedPanes = new Set<string>();

async function ensureDebuggerAttached(
	paneId: string,
): Promise<Electron.WebContents> {
	const wc = browserManager.getWebContents(paneId);
	if (!wc) throw new Error(`pane ${paneId} is not registered`);
	if (!wc.debugger.isAttached()) {
		try {
			wc.debugger.attach("1.3");
		} catch (error) {
			throw new Error(
				`Failed to attach CDP to pane ${paneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await wc.debugger.sendCommand("Page.enable");
		await wc.debugger.sendCommand("Runtime.enable");
		await wc.debugger.sendCommand("Log.enable").catch(() => {});
		wc.debugger.on("message", (_event, method, params) => {
			if (
				method === "Runtime.consoleAPICalled" ||
				method === "Log.entryAdded"
			) {
				const level =
					(params as { type?: string; entry?: { level?: string } }).type ??
					(params as { entry?: { level?: string } }).entry?.level ??
					"log";
				const args =
					(params as { args?: Array<{ value?: unknown }> }).args ?? [];
				const text =
					(params as { entry?: { text?: string } }).entry?.text ??
					args
						.map((a) =>
							a.value === undefined ? "(unserializable)" : String(a.value),
						)
						.join(" ");
				const buf = consoleByPane.get(paneId) ?? [];
				buf.push({ level, message: text, at: Date.now() });
				if (buf.length > CONSOLE_BUFFER_LIMIT) buf.shift();
				consoleByPane.set(paneId, buf);
			}
		});
		wc.debugger.on("detach", () => {
			attachedPanes.delete(paneId);
		});
		attachedPanes.add(paneId);
	}
	return wc;
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
				"Could not map this MCP to a Superset LLM session. Make sure Claude / Codex is running inside a Superset terminal pane or as a TODO-Agent worker.",
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? (JSON.parse(raw) as T) : ({} as T);
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

			if (req.method === "POST" && url.pathname === "/mcp/navigate") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved)
					return send(res, resolved.status, { error: resolved.error });
				const body = await readJson<{ url?: string }>(req);
				if (!body.url) return send(res, 400, { error: "url required" });
				const wc = await ensureDebuggerAttached(resolved.paneId);
				await wc.debugger.sendCommand("Page.navigate", { url: body.url });
				return send(res, 200, { paneId: resolved.paneId, url: body.url });
			}

			if (req.method === "POST" && url.pathname === "/mcp/screenshot") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved)
					return send(res, resolved.status, { error: resolved.error });
				const wc = await ensureDebuggerAttached(resolved.paneId);
				const out = (await wc.debugger.sendCommand("Page.captureScreenshot", {
					format: "png",
					captureBeyondViewport: false,
				})) as { data: string };
				return send(res, 200, {
					paneId: resolved.paneId,
					base64: out.data,
					mimeType: "image/png",
				});
			}

			if (req.method === "POST" && url.pathname === "/mcp/evaluate") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved)
					return send(res, resolved.status, { error: resolved.error });
				const body = await readJson<{ code?: string }>(req);
				if (typeof body.code !== "string") {
					return send(res, 400, { error: "code required" });
				}
				const wc = await ensureDebuggerAttached(resolved.paneId);
				const out = (await wc.debugger.sendCommand("Runtime.evaluate", {
					expression: body.code,
					awaitPromise: true,
					returnByValue: true,
				})) as {
					result?: { value?: unknown };
					exceptionDetails?: {
						text?: string;
						exception?: { description?: string };
					};
				};
				return send(res, 200, {
					paneId: resolved.paneId,
					value: out.result?.value ?? null,
					exceptionDetails: out.exceptionDetails
						? (out.exceptionDetails.exception?.description ??
							out.exceptionDetails.text ??
							"unknown exception")
						: undefined,
				});
			}

			if (req.method === "GET" && url.pathname === "/mcp/console-logs") {
				const resolved = await resolvePaneFromRequest(req);
				if ("error" in resolved)
					return send(res, resolved.status, { error: resolved.error });
				// Make sure logging is being captured for this pane.
				await ensureDebuggerAttached(resolved.paneId);
				const entries = consoleByPane.get(resolved.paneId) ?? [];
				consoleByPane.set(resolved.paneId, []);
				return send(res, 200, { paneId: resolved.paneId, entries });
			}

			return send(res, 404, { error: "not found" });
		} catch (error) {
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
