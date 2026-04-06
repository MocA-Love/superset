/**
 * Local HTTP server for serving VS Code extension webview content.
 *
 * Serves both webview HTML pages and extension resources (JS/CSS/images)
 * on localhost with appropriate CSP headers. This bypasses all iframe
 * CSP/protocol restrictions since HTTP is universally supported.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
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
	".wasm": "application/wasm",
};

const ALLOWED_ROOTS = [
	path.join(os.homedir(), ".vscode", "extensions"),
	path.join(os.homedir(), ".vscode-insiders", "extensions"),
];

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	return ALLOWED_ROOTS.some(
		(root) => resolved === root || resolved.startsWith(root + path.sep),
	);
}

/** Store for webview HTML content, keyed by viewId */
const htmlStore = new Map<string, string>();

/** Bridge script injected into every webview page */
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

let server: http.Server | null = null;
let serverPort = 0;

export function getWebviewServerPort(): number {
	return serverPort;
}

export function setWebviewHtml(viewId: string, html: string): void {
	htmlStore.set(viewId, html);
}

export function clearWebviewHtml(viewId: string): void {
	htmlStore.delete(viewId);
}

export function getWebviewUrl(viewId: string): string {
	return `http://127.0.0.1:${serverPort}/webview/${encodeURIComponent(viewId)}`;
}

/**
 * Rewrite vscode-webview-resource:// URLs in HTML to use our HTTP server.
 */
function rewriteResourceUrls(html: string): string {
	return html.replace(
		/vscode-webview-resource:\/\/([^"'\s)]+)/g,
		(_, resourcePath) => {
			const decoded = decodeURIComponent(resourcePath);
			return `http://127.0.0.1:${serverPort}/resource${decoded}`;
		},
	);
}

/**
 * Strip the extension's own CSP meta tag and nonce attributes.
 * Our HTTP server provides its own CSP via response headers.
 * Extensions set restrictive CSPs with nonces that block our bridge script.
 */
function stripExtensionCsp(html: string): string {
	// Remove CSP meta tags
	let result = html.replace(
		/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
		"",
	);
	// Remove nonce attributes from script/style tags
	result = result.replace(/\s+nonce=["'][^"']*["']/g, "");
	return result;
}

function injectBridge(html: string): string {
	if (html.includes("</head>")) {
		return html.replace("</head>", `${BRIDGE_SCRIPT}</head>`);
	}
	return `${BRIDGE_SCRIPT}${html}`;
}

export async function startWebviewServer(): Promise<number> {
	if (server) return serverPort;

	return new Promise((resolve, reject) => {
		server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1`);

			// Serve webview HTML pages: /webview/{viewId}
			if (url.pathname.startsWith("/webview/")) {
				const viewId = decodeURIComponent(
					url.pathname.slice("/webview/".length),
				);
				let html = htmlStore.get(viewId);

				if (!html) {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end(`View not found: ${viewId}`);
					return;
				}

				// Strip extension's CSP (we provide our own via headers), rewrite URLs, inject bridge
				html = stripExtensionCsp(html);
				html = rewriteResourceUrls(html);
				html = injectBridge(html);

				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": [
						"default-src 'none'",
						`script-src 'unsafe-inline' http://127.0.0.1:${serverPort}`,
						`style-src 'unsafe-inline' http://127.0.0.1:${serverPort}`,
						`img-src http://127.0.0.1:${serverPort} https: data:`,
						`font-src http://127.0.0.1:${serverPort} https: data:`,
						"connect-src https: wss: ws: http://127.0.0.1:*",
						`frame-src http://127.0.0.1:${serverPort}`,
					].join("; "),
					"Access-Control-Allow-Origin": "*",
				});
				res.end(html);
				return;
			}

			// Serve extension resources: /resource/{filepath}
			if (url.pathname.startsWith("/resource/")) {
				let filePath = decodeURIComponent(
					url.pathname.slice("/resource".length),
				);

				// Normalize path
				if (process.platform === "darwin" && filePath.startsWith("//")) {
					filePath = filePath.slice(1);
				}

				if (!isPathAllowed(filePath)) {
					res.writeHead(403, { "Content-Type": "text/plain" });
					res.end("Forbidden");
					return;
				}

				if (!fs.existsSync(filePath)) {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("Not found");
					return;
				}

				const ext = path.extname(filePath).toLowerCase();
				const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

				const content = fs.readFileSync(filePath);
				res.writeHead(200, {
					"Content-Type": mimeType,
					"Cache-Control": "public, max-age=3600",
				});
				res.end(content);
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server?.address();
			if (addr && typeof addr === "object") {
				serverPort = addr.port;
				console.log(
					`[vscode-shim] Webview server listening on http://127.0.0.1:${serverPort}`,
				);
				resolve(serverPort);
			} else {
				reject(new Error("Failed to get server address"));
			}
		});

		server.on("error", reject);
	});
}

export function stopWebviewServer(): void {
	server?.close();
	server = null;
	serverPort = 0;
}
