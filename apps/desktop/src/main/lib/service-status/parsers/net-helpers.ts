import { net } from "electron";
import { parseSafeHttpUrl } from "../url-safety";

/**
 * Shared Electron-net fetch helpers for the status parsers. Using `net.request`
 * (Chromium network stack) instead of Node's `fetch` bypasses renderer-side
 * CORS / proxy quirks and gives us consistent redirect/timeout behavior across
 * every adapter.
 *
 * Redirects are handled manually so a trusted public host can't 30x-redirect
 * us to an internal endpoint (cloud metadata, LAN admin panel, etc.) after
 * the tRPC input validator has already approved the initial URL.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

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

interface SingleHopResult {
	statusCode: number;
	headers: Record<string, string | string[]>;
	body: string;
}

/**
 * Issue a single request (no redirect following). Callers wrap this in
 * `fetchText` to perform the redirect loop with per-hop host re-validation.
 */
function fetchOnce(
	url: string,
	timeoutMs: number,
	accept: string | undefined,
): Promise<SingleHopResult> {
	return new Promise((resolve, reject) => {
		const request = net.request({ method: "GET", url, redirect: "manual" });
		if (accept) request.setHeader("Accept", accept);
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
				resolve({
					statusCode: response.statusCode,
					headers: response.headers as Record<string, string | string[]>,
					body: Buffer.concat(chunks).toString("utf-8"),
				});
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

function getLocationHeader(
	headers: Record<string, string | string[]>,
): string | null {
	const raw = headers.location ?? headers.Location;
	if (!raw) return null;
	return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

/**
 * GET a URL and return the raw response body as a UTF-8 string. Rejects on
 * non-2xx status codes, timeouts, network errors, and — critically —
 * redirects whose Location targets a private / loopback host. Each Location
 * hop is re-validated with the same `parseSafeHttpUrl` the tRPC input
 * schema uses, so an attacker-controlled public endpoint can't escape the
 * sandbox by handing us a 302 to `http://169.254.169.254/`.
 */
export async function fetchText(
	url: string,
	options?: FetchOptions,
): Promise<string> {
	const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const initial = parseSafeHttpUrl(currentUrl);
		if (!initial) {
			throw new StatusFetchError(
				`Refusing to fetch non-public or malformed URL: ${currentUrl}`,
			);
		}
		const { statusCode, headers, body } = await fetchOnce(
			currentUrl,
			timeoutMs,
			options?.accept,
		);
		if (statusCode >= 300 && statusCode < 400) {
			const location = getLocationHeader(headers);
			if (!location) {
				throw new StatusFetchError(`HTTP ${statusCode} without Location`);
			}
			let nextUrl: string;
			try {
				nextUrl = new URL(location, currentUrl).toString();
			} catch {
				throw new StatusFetchError(`Invalid redirect target: ${location}`);
			}
			if (!parseSafeHttpUrl(nextUrl)) {
				throw new StatusFetchError(
					`Refusing to follow redirect to private / non-http host: ${nextUrl}`,
				);
			}
			currentUrl = nextUrl;
			continue;
		}
		if (statusCode < 200 || statusCode >= 300) {
			throw new StatusFetchError(`HTTP ${statusCode}`);
		}
		return body;
	}
	throw new StatusFetchError(
		`Exceeded ${MAX_REDIRECTS} redirect hops starting from ${url}`,
	);
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
