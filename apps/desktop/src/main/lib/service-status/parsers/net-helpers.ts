import { net } from "electron";

/**
 * Shared Electron-net fetch helpers for the status parsers. Using `net.request`
 * (Chromium network stack) instead of Node's `fetch` bypasses renderer-side
 * CORS / proxy quirks and gives us consistent redirect/timeout behavior across
 * every adapter.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export class StatusFetchError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "StatusFetchError";
	}
}

interface FetchOptions {
	timeoutMs?: number;
	accept?: string;
}

/**
 * GET a URL and return the raw response body as a UTF-8 string. Rejects on
 * non-2xx status codes, timeouts, and network errors so each parser can fold
 * the error into a uniform `{indicator: null, description: "…"}` shape.
 */
export function fetchText(
	url: string,
	options?: FetchOptions,
): Promise<string> {
	const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const request = net.request({ method: "GET", url, redirect: "follow" });
		if (options?.accept) {
			request.setHeader("Accept", options.accept);
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			request.abort();
			reject(new StatusFetchError(`Request timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		request.on("response", (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});
			response.on("end", () => {
				clearTimeout(timer);
				if (timedOut) return;
				if (response.statusCode < 200 || response.statusCode >= 300) {
					reject(new StatusFetchError(`HTTP ${response.statusCode}`));
					return;
				}
				resolve(Buffer.concat(chunks).toString("utf-8"));
			});
			response.on("error", (err: Error) => {
				clearTimeout(timer);
				if (timedOut) return;
				reject(new StatusFetchError(err.message, err));
			});
		});
		request.on("error", (err) => {
			clearTimeout(timer);
			if (timedOut) return;
			reject(new StatusFetchError(err.message, err));
		});
		request.end();
	});
}

export async function fetchJson<T = unknown>(
	url: string,
	options?: FetchOptions,
): Promise<T> {
	const body = await fetchText(url, {
		...options,
		accept: options?.accept ?? "application/json",
	});
	try {
		return JSON.parse(body) as T;
	} catch (error) {
		throw new StatusFetchError(
			error instanceof Error ? error.message : "Invalid JSON response",
			error,
		);
	}
}
