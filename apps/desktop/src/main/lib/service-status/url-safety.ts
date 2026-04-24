/**
 * Shared URL safety predicates for the service-status feature.
 *
 * Used at two layers:
 *   1. tRPC input validation in `routers/service-status.ts` rejects user-
 *      provided URLs whose host is private / loopback / link-local.
 *   2. `parsers/net-helpers.ts` re-validates Location headers on every
 *      redirect hop so a trusted public host can't 30x-redirect us to a
 *      cloud metadata endpoint (classic SSRF bypass).
 *
 * Keep this module dependency-free so both tRPC and the fetcher can import
 * it without pulling in the full service layer.
 */

/**
 * Reject private / loopback hosts so user-supplied URLs can't be abused to
 * reach cloud metadata endpoints (169.254.169.254), internal admin panels,
 * or other LAN services from the main process via `net.request`.
 *
 * `URL.hostname` needs normalization before matching:
 *   - IPv6 literals come back bracketed (`http://[::1]` → `[::1]`), so the
 *     `::1` / `fe80::` / `fc00::` patterns would silently miss them.
 *   - DNS allows a trailing dot (`localhost.` resolves to loopback on most
 *     resolvers) and it survives `URL` parsing.
 *   - The IPv4-mapped IPv6 form `::ffff:127.0.0.1` routes to loopback but
 *     wouldn't match the raw IPv4 regex.
 */
export function isPublicHttpsHost(hostname: string): boolean {
	let host = hostname.toLowerCase();
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	if (!host) return false;
	if (host === "localhost") return false;
	if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0")
		return false;
	if (/^127\./.test(host)) return false;
	if (/^10\./.test(host)) return false;
	if (/^192\.168\./.test(host)) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
	if (/^169\.254\./.test(host)) return false;
	const embeddedV4 = extractV4MappedToIPv6(host);
	if (embeddedV4) {
		if (embeddedV4 === "127.0.0.1" || embeddedV4 === "0.0.0.0") return false;
		if (/^127\./.test(embeddedV4)) return false;
		if (/^10\./.test(embeddedV4)) return false;
		if (/^192\.168\./.test(embeddedV4)) return false;
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(embeddedV4)) return false;
		if (/^169\.254\./.test(embeddedV4)) return false;
	}
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
	if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
	return true;
}

/**
 * Extract the embedded IPv4 address from a v4-mapped IPv6 literal, in either
 * of the two shapes WHATWG URL parsers emit. Returns `null` for anything
 * that isn't a v4-mapped v6 address (including pure v4 strings — callers
 * still run their own v4 regex set on the original host).
 */
export function extractV4MappedToIPv6(host: string): string | null {
	const dotted = host.match(
		/^(?:0{1,4}:){0,5}:?:?ffff:((?:\d{1,3}\.){3}\d{1,3})$/i,
	);
	if (dotted?.[1]) return dotted[1];
	const hex = host.match(
		/^(?:0{1,4}:){0,5}:?:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,
	);
	if (hex?.[1] && hex[2]) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		if (high > 0xffff || low > 0xffff) return null;
		return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
	}
	return null;
}

/**
 * Parse a URL string and confirm it points to a public http(s) host. Returns
 * the parsed URL on success or `null` on any failure (parse error, non-http
 * protocol, or private host).
 */
export function parseSafeHttpUrl(value: string): URL | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	if (!isPublicHttpsHost(parsed.hostname)) return null;
	return parsed;
}
