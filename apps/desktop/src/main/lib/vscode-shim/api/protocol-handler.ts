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

		// Serve webview HTML pages with their own CSP (bypasses parent CSP)
		protocol.handle("vscode-webview", (request: Request) => {
			const url = new URL(request.url);
			const viewId = url.pathname.replace(/^\/+/, "");
			let html =
				webviewHtmlStore.get(viewId) ?? "<html><body>No content</body></html>";

			// Inject acquireVsCodeApi bridge script
			html = injectBridgeScript(html);

			return new Response(html, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": [
						"default-src 'none'",
						"script-src 'unsafe-inline' vscode-webview-resource:",
						"style-src 'unsafe-inline' vscode-webview-resource:",
						"img-src vscode-webview-resource: https: data:",
						"font-src vscode-webview-resource: https: data:",
						"connect-src https: wss: ws:",
					].join("; "),
				},
			});
		});

		console.log("[vscode-shim] Registered vscode-webview:// protocol");
	} catch (err) {
		console.warn("[vscode-shim] Failed to register protocol handler:", err);
	}
}

const BRIDGE_SCRIPT = `<script>
(function() {
	let _state = null;
	const vscodeApi = {
		postMessage(message) {
			window.parent.postMessage({ type: 'vscode-api', data: message }, '*');
		},
		getState() { return _state; },
		setState(state) { _state = state; return state; }
	};
	window.acquireVsCodeApi = function() { return vscodeApi; };
	window.addEventListener('message', function(event) {
		if (event.data && event.data.type === 'vscode-message') {
			window.dispatchEvent(new MessageEvent('message', { data: event.data.data }));
		}
	});
})();
</script>`;

function injectBridgeScript(html: string): string {
	if (html.includes("</head>")) {
		return html.replace("</head>", `${BRIDGE_SCRIPT}</head>`);
	}
	if (html.includes("<body")) {
		return html.replace(/<body([^>]*)>/, `<body$1>${BRIDGE_SCRIPT}`);
	}
	return `${BRIDGE_SCRIPT}${html}`;
}

/** Store for webview HTML content, keyed by viewId */
const webviewHtmlStore = new Map<string, string>();

export function setWebviewHtml(viewId: string, html: string): void {
	webviewHtmlStore.set(viewId, html);
}

export function clearWebviewHtml(viewId: string): void {
	webviewHtmlStore.delete(viewId);
}
