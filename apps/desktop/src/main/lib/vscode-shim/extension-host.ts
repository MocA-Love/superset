/**
 * Extension Host: high-level API to manage VS Code extensions in Superset Desktop.
 */

import os from "node:os";
import path from "node:path";
import { shimLog, shimWarn } from "./api/debug-log";
import { registerWebviewProtocol } from "./api/protocol-handler";
import { startWebviewServer, stopWebviewServer } from "./api/webview-server";
import { setWorkspacePath } from "./api/workspace";
import {
	deactivateAll,
	discoverExtensions,
	getLoadedExtensions,
	loadExtension,
} from "./loader";
import type { ExtensionInfo } from "./types";

// Known extension IDs we support
const SUPPORTED_EXTENSIONS = new Set([
	"anthropic.claude-code",
	"openai.chatgpt",
]);

interface ExtensionHostOptions {
	/** Path to VS Code extensions directory. Defaults to ~/.vscode/extensions */
	extensionsDir?: string;
	/** Current workspace folder path */
	workspacePath?: string;
	/** Specific extension IDs to load. Defaults to SUPPORTED_EXTENSIONS */
	extensionIds?: string[];
}

let isInitialized = false;

export async function initExtensionHost(
	options: ExtensionHostOptions = {},
): Promise<void> {
	if (isInitialized) {
		shimWarn("[vscode-shim] Extension host already initialized");
		return;
	}

	const extensionsDir =
		options.extensionsDir ?? path.join(os.homedir(), ".vscode", "extensions");
	const targetIds = new Set(options.extensionIds ?? SUPPORTED_EXTENSIONS);

	if (options.workspacePath) {
		setWorkspacePath(options.workspacePath);
	}

	// Register protocol handler for webview resources
	registerWebviewProtocol();

	// Start HTTP server for webview content
	await startWebviewServer();

	// Set platform context keys (Codex checks these)
	const { commands } =
		require("./api/commands") as typeof import("./api/commands");
	const platform =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "win32"
				? "windows"
				: "linux";
	commands.executeCommand("setContext", "os", platform);

	shimLog(`[vscode-shim] Discovering extensions in ${extensionsDir}`);
	const discovered = discoverExtensions(extensionsDir);
	shimLog(`[vscode-shim] Found ${discovered.length} extensions total`);

	// Filter to supported extensions, pick latest version for each
	const toLoad = selectExtensions(discovered, targetIds);
	shimLog(
		`[vscode-shim] Loading ${toLoad.length} extensions: ${toLoad.map((e) => e.id).join(", ")}`,
	);

	for (const ext of toLoad) {
		try {
			await loadExtension(ext);
		} catch (err) {
			console.error(`[vscode-shim] Failed to load ${ext.id}:`, err);
			// Continue loading other extensions
		}
	}

	isInitialized = true;
}

/** Compare semver-like version strings. Returns positive if a > b. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va !== vb) return va - vb;
	}
	return 0;
}

/** Pick the latest version of each target extension */
function selectExtensions(
	all: ExtensionInfo[],
	targetIds: Set<string>,
): ExtensionInfo[] {
	const byId = new Map<string, ExtensionInfo>();

	for (const ext of all) {
		if (!targetIds.has(ext.id)) continue;

		const existing = byId.get(ext.id);
		if (!existing) {
			byId.set(ext.id, ext);
		} else {
			if (
				compareVersions(ext.manifest.version, existing.manifest.version) > 0
			) {
				byId.set(ext.id, ext);
			}
		}
	}

	return [...byId.values()];
}

export async function shutdownExtensionHost(): Promise<void> {
	shimLog("[vscode-shim] Shutting down extension host");
	await deactivateAll();
	stopWebviewServer();
	isInitialized = false;
}

export function updateWorkspacePath(workspacePath: string): void {
	setWorkspacePath(workspacePath);
}

export function getActiveExtensions(): Array<{
	id: string;
	isActive: boolean;
}> {
	return getLoadedExtensions().map((ext) => ({
		id: ext.info.id,
		isActive: ext.info.isActive,
	}));
}

/** Restart a specific extension (deactivate + re-activate) */
export async function restartExtension(extensionId: string): Promise<boolean> {
	const { deactivateExtension, getLoadedExtension } = await import("./loader");
	const loaded = getLoadedExtension(extensionId);
	if (!loaded) return false;

	const info = { ...loaded.info, isActive: false };
	await deactivateExtension(extensionId);

	try {
		await loadExtension(info);
		shimLog(`[vscode-shim] Restarted extension: ${extensionId}`);
		return true;
	} catch (err) {
		console.error(`[vscode-shim] Failed to restart ${extensionId}:`, err);
		return false;
	}
}

export { isInitialized as isExtensionHostInitialized };
