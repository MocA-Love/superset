/**
 * Electron protocol handler for serving VS Code extension webview resources.
 *
 * Registers `vscode-webview-resource://` protocol to serve local files
 * from extension directories. The main webview HTML is served by
 * webview-server.ts instead (HTTP on localhost).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shimLog } from "./debug-log";

/** Allowed base directories for serving extension resources */
const ALLOWED_ROOTS: string[] = [
	path.join(os.homedir(), ".vscode", "extensions"),
	path.join(os.homedir(), ".vscode-insiders", "extensions"),
];

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	return ALLOWED_ROOTS.some(
		(root) => resolved === root || resolved.startsWith(root + path.sep),
	);
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".ico": "image/x-icon",
};

function getMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function registerWebviewProtocol(): void {
	try {
		const { protocol } = require("electron");

		protocol.handle("vscode-webview-resource", (request: Request) => {
			const url = new URL(request.url);
			let filePath = decodeURIComponent(url.pathname);

			if (process.platform === "darwin" && filePath.startsWith("//")) {
				filePath = filePath.slice(1);
			}

			if (!isPathAllowed(filePath)) {
				return new Response("Forbidden", { status: 403 });
			}

			if (!fs.existsSync(filePath)) {
				return new Response("Not found", { status: 404 });
			}

			const content = fs.readFileSync(filePath);
			const mimeType = getMimeType(filePath);

			return new Response(content, {
				headers: { "Content-Type": mimeType },
			});
		});

		shimLog("[vscode-shim] Registered vscode-webview-resource:// protocol");
	} catch (err) {
		console.error("[vscode-shim] Failed to register protocol handler:", err);
	}
}
