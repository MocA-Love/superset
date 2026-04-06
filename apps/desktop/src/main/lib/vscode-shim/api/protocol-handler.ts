/**
 * Electron protocol handler for serving VS Code extension webview resources.
 *
 * Registers `vscode-webview-resource://` protocol to serve local files
 * from extension directories, enabling webview HTML to load CSS/JS/images.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Allowed base directories for serving extension resources */
const ALLOWED_ROOTS: string[] = [
	path.join(os.homedir(), ".vscode", "extensions"),
	path.join(os.homedir(), ".vscode-insiders", "extensions"),
];

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	return ALLOWED_ROOTS.some((root) => resolved.startsWith(root + path.sep));
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
			// The path contains the local file path
			let filePath = decodeURIComponent(url.pathname);

			// On macOS, pathname might start with extra slash
			if (process.platform === "darwin" && filePath.startsWith("//")) {
				filePath = filePath.slice(1);
			}

			// Prevent path traversal — only serve files from extension directories
			if (!isPathAllowed(filePath)) {
				return new Response("Forbidden", { status: 403 });
			}

			if (!fs.existsSync(filePath)) {
				return new Response("Not found", { status: 404 });
			}

			const content = fs.readFileSync(filePath);
			const mimeType = getMimeType(filePath);

			return new Response(content, {
				headers: {
					"Content-Type": mimeType,
				},
			});
		});

		console.log("[vscode-shim] Registered vscode-webview-resource:// protocol");
	} catch (err) {
		console.warn("[vscode-shim] Failed to register protocol handler:", err);
	}
}
