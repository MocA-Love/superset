import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime info written by the Superset app on startup to
 * `$SUPERSET_HOME_DIR/browser-mcp.json` (workspace-scoped so multiple
 * Superset instances do not collide). Defaults to `~/.superset` when the
 * env var is not set. This MCP server reads that file to discover where
 * to talk to the app.
 */
function runtimeInfoPath(): string {
	const home = process.env.SUPERSET_HOME_DIR?.trim();
	const base = home && home.length > 0 ? home : join(homedir(), ".superset");
	return join(base, "browser-mcp.json");
}

interface RuntimeInfo {
	port: number;
	secret: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

function readRuntimeInfo(): RuntimeInfo {
	const contents = readFileSync(runtimeInfoPath(), "utf8");
	const parsed = JSON.parse(contents) as Partial<RuntimeInfo>;
	const { port, secret } = parsed;
	if (
		!Number.isInteger(port) ||
		(port as number) < 1 ||
		(port as number) > 65_535 ||
		typeof secret !== "string" ||
		secret.length === 0
	) {
		throw new Error(
			`Invalid ${runtimeInfoPath()}: expected { port: 1..65535, secret: non-empty string }`,
		);
	}
	return { port: port as number, secret };
}

export class BridgeUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			`Superset app is not reachable. Make sure Superset is running, then restart this MCP. (cause: ${
				cause instanceof Error ? cause.message : String(cause)
			})`,
		);
		this.name = "BridgeUnavailableError";
	}
}

export class BridgeClient {
	private info: RuntimeInfo | null = null;
	private readonly ppid: number;

	constructor(ppid: number) {
		this.ppid = ppid;
	}

	private load(): RuntimeInfo {
		if (!this.info) this.info = readRuntimeInfo();
		return this.info;
	}

	reset(): void {
		this.info = null;
	}

	async request<T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<T> {
		const perform = async (info: RuntimeInfo): Promise<Response> => {
			// If the cached port was reused by an unrelated process that
			// hangs instead of replying, the MCP tool call would stall
			// forever. Apply a deadline so the retry/reset path can take
			// over.
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			try {
				return await fetch(`http://127.0.0.1:${info.port}${path}`, {
					method,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${info.secret}`,
						"x-superset-mcp-ppid": String(this.ppid),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}
		};

		let response: Response;
		try {
			const info = this.load();
			response = await perform(info);
		} catch (error) {
			// ENOENT / JSON parse / connection refused: Superset may have
			// been started after this MCP, restarted on a new port, or the
			// SUPERSET_HOME_DIR env was wrong. Drop the cached file and try
			// once more; if that still fails, surface the friendly
			// BridgeUnavailableError instead of a raw fs/fetch exception.
			this.reset();
			try {
				const fresh = this.load();
				response = await perform(fresh);
			} catch (retryError) {
				throw new BridgeUnavailableError(retryError ?? error);
			}
		}
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(`Superset bridge ${response.status}: ${text}`);
		}
		return (await response.json()) as T;
	}
}
