const PROBE_TIMEOUT_MS = 3_000;

export async function primeRelayAffinity(wsUrl: string): Promise<void> {
	try {
		const url = new URL(wsUrl);
		const match = url.pathname.match(/^(\/hosts\/[^/]+)/);
		if (!match) return;
		url.pathname = `${match[1]}/_whoowns`;
		url.protocol = url.protocol === "wss:" ? "https:" : "http:";

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		try {
			await fetch(url.toString(), {
				method: "GET",
				signal: controller.signal,
				cache: "no-store",
			});
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// Best-effort: the WebSocket attempt should still proceed.
	}
}
