import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Resolve the port Chromium chose for `--remote-debugging-port=0`.
 *
 * When Chromium opens the CDP server it writes a file called
 * `DevToolsActivePort` in the user data directory. Its first line is
 * the assigned port number. We read that file with a small retry so
 * the resolution works even if callers query before Chromium has
 * finished writing it (the file appears after `app.whenReady()` but
 * right around the same time startBrowserMcpBridge fires).
 */
const DEVTOOLS_FILE = "DevToolsActivePort";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function readOnce(): number | null {
	const path = join(app.getPath("userData"), DEVTOOLS_FILE);
	if (!existsSync(path)) return null;
	try {
		const contents = readFileSync(path, "utf8").trim();
		if (!contents) return null;
		const firstLine = contents.split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine) return null;
		const port = Number.parseInt(firstLine, 10);
		return Number.isFinite(port) && port > 0 ? port : null;
	} catch {
		return null;
	}
}

export async function resolveCdpPort(
	timeoutMs = 5_000,
): Promise<number | null> {
	// When DESKTOP_AUTOMATION_PORT is explicitly set, trust it — Chromium
	// is using that exact port, no file lookup needed.
	const envPort = process.env.DESKTOP_AUTOMATION_PORT;
	if (envPort) {
		const parsed = Number.parseInt(envPort, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const deadline = Date.now() + timeoutMs;
	let port = readOnce();
	while (!port && Date.now() < deadline) {
		await sleep(100);
		port = readOnce();
	}
	return port;
}
