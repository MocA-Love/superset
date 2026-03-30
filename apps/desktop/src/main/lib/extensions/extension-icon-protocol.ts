import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { net } from "electron";
import type { ChromeManifest } from "./crx-downloader";
import { getExtensionsDir } from "./crx-downloader";

/**
 * Resolve the best icon file path from a manifest's action or icons field.
 *
 * Tries `action.default_icon` first (string or size map), then falls back
 * to `manifest.icons`. Returns the absolute path to the icon file, or null.
 */
function resolveIconFile(
	extensionDir: string,
	manifest: ChromeManifest,
	requestedSize: number,
): string | null {
	const action = manifest.action ?? manifest.browser_action;
	const iconSource = action?.default_icon ?? manifest.icons;

	if (!iconSource) return null;

	// Single string path
	if (typeof iconSource === "string") {
		const fullPath = path.join(extensionDir, iconSource);
		return existsSync(fullPath) ? fullPath : null;
	}

	// Record<string, string> – find closest size
	const sizes = Object.keys(iconSource)
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);

	if (sizes.length === 0) return null;

	// Pick the smallest size >= requestedSize, or the largest available
	const bestSize =
		sizes.find((s) => s >= requestedSize) ?? sizes[sizes.length - 1];

	const iconRelPath = iconSource[String(bestSize)];
	if (!iconRelPath) return null;

	const fullPath = path.join(extensionDir, iconRelPath);
	return existsSync(fullPath) ? fullPath : null;
}

/**
 * Create a protocol handler that serves extension icon images.
 *
 * URL format: `superset-ext-icon://{extensionId}/{size}`
 *   e.g. `superset-ext-icon://abcdefghijklmnopabcdefghijklmnop/32`
 *
 * The handler reads the extension's manifest.json to locate the best
 * matching icon file and returns it via `net.fetch`.
 */
export function createExtensionIconProtocolHandler(): (
	request: Request,
) => Response | Promise<Response> {
	return async (request: Request) => {
		try {
			const url = new URL(request.url);
			const extensionId = url.hostname;
			const size = Number.parseInt(url.pathname.replace(/^\//, ""), 10) || 32;

			const extensionDir = path.join(getExtensionsDir(), extensionId);
			const manifestPath = path.join(extensionDir, "manifest.json");

			if (!existsSync(manifestPath)) {
				return new Response("Extension not found", { status: 404 });
			}

			const { readFile } = await import("node:fs/promises");
			const manifest: ChromeManifest = JSON.parse(
				await readFile(manifestPath, "utf-8"),
			);

			const iconPath = resolveIconFile(extensionDir, manifest, size);
			if (!iconPath) {
				return new Response("Icon not found", { status: 404 });
			}

			return net.fetch(pathToFileURL(iconPath).toString());
		} catch {
			return new Response("Internal error", { status: 500 });
		}
	};
}
