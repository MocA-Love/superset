import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import type { Plugin } from "vite";

import { main, resources } from "../package.json";

export const devPath = normalize(dirname(main)).split(/\/|\\/g)[0];

function copyDir({ src, dest }: { src: string; dest: string }): void {
	if (!existsSync(src)) return;

	if (existsSync(dest)) {
		rmSync(dest, { recursive: true });
	}
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, { recursive: true });
}

export function defineEnv(
	value: string | undefined,
	fallback?: string,
): string {
	// `||` instead of `??` so empty strings from unresolved CI secrets fall
	// back to the default (matters when a CI workflow references a missing
	// env var and injects the empty string).
	return JSON.stringify(value || fallback);
}

const RESOURCES_TO_COPY = [
	{
		src: resolve(__dirname, "..", resources, "sounds"),
		dest: resolve(__dirname, "..", devPath, "resources/sounds"),
	},
	{
		src: resolve(__dirname, "..", resources, "tray"),
		dest: resolve(__dirname, "..", devPath, "resources/tray"),
	},
	{
		src: resolve(__dirname, "..", resources, "browser-extension"),
		dest: resolve(__dirname, "..", devPath, "resources/browser-extension"),
	},
	{
		src: resolve(__dirname, "../../../packages/local-db/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/migrations"),
	},
	{
		src: resolve(__dirname, "../../../packages/host-service/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/host-migrations"),
	},
	{
		src: resolve(__dirname, "../src/main/lib/agent-setup/templates"),
		dest: resolve(__dirname, "..", devPath, "main/templates"),
	},
];

/**
 * Copies resources to dist/ for preview/production mode.
 * In preview mode, __dirname resolves relative to dist/main, so resources
 * need to be copied there for the main process to access them.
 */
export function copyResourcesPlugin(): Plugin {
	return {
		name: "copy-resources",
		writeBundle() {
			for (const resource of RESOURCES_TO_COPY) {
				copyDir(resource);
			}
		},
	};
}

/**
 * Strips the `crossorigin` attribute that Vite injects on <script>/<link> tags.
 * Electron's ASAR file:// handler doesn't honor CORS on Windows, so crossorigin
 * causes scripts/styles to fail loading and leaves the renderer with a black
 * screen. No-op on macOS/Linux.
 */
export function stripCrossOriginPlugin(): Plugin {
	return {
		name: "strip-crossorigin",
		transformIndexHtml: {
			order: "post",
			handler(html) {
				if (process.platform !== "win32") return html;
				return html.replace(/ crossorigin(?:="[^"]*")?/g, "");
			},
		},
	};
}

/**
 * Injects environment variables into index.html CSP.
 */
export function htmlEnvTransformPlugin(): Plugin {
	return {
		name: "html-env-transform",
		transformIndexHtml(html) {
			return html
				.replace(
					/%NEXT_PUBLIC_API_URL%/g,
					process.env.NEXT_PUBLIC_API_URL || "https://api.superset.sh",
				)
				.replace(
					/%NEXT_PUBLIC_ELECTRIC_URL%/g,
					new URL(
						process.env.NEXT_PUBLIC_ELECTRIC_URL ||
							"https://electric-proxy.avi-6ac.workers.dev",
					).origin,
				)
				.replace(
					/%NEXT_PUBLIC_STREAMS_URL%/g,
					process.env.NEXT_PUBLIC_STREAMS_URL || "https://streams.superset.sh",
				)
				.replace(
					/%RELAY_URL%/g,
					process.env.RELAY_URL || "https://relay.superset.sh",
				);
		},
	};
}
