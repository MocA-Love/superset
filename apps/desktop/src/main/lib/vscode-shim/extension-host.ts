/**
 * Extension Host: high-level API to manage VS Code extensions in Superset Desktop.
 */

import os from "node:os";
import path from "node:path";
import {
	discoverExtensions,
	loadExtension,
	deactivateAll,
	getLoadedExtensions,
} from "./loader.js";
import { setWorkspacePath } from "./api/workspace.js";
import type { ExtensionInfo } from "./types.js";

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

export async function initExtensionHost(options: ExtensionHostOptions = {}): Promise<void> {
	if (isInitialized) {
		console.warn("[vscode-shim] Extension host already initialized");
		return;
	}

	const extensionsDir =
		options.extensionsDir ?? path.join(os.homedir(), ".vscode", "extensions");
	const targetIds = new Set(options.extensionIds ?? SUPPORTED_EXTENSIONS);

	if (options.workspacePath) {
		setWorkspacePath(options.workspacePath);
	}

	console.log(`[vscode-shim] Discovering extensions in ${extensionsDir}`);
	const discovered = discoverExtensions(extensionsDir);
	console.log(`[vscode-shim] Found ${discovered.length} extensions total`);

	// Filter to supported extensions, pick latest version for each
	const toLoad = selectExtensions(discovered, targetIds);
	console.log(`[vscode-shim] Loading ${toLoad.length} extensions: ${toLoad.map((e) => e.id).join(", ")}`);

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
			// Simple version comparison: prefer later directory (higher version)
			if (ext.extensionPath > existing.extensionPath) {
				byId.set(ext.id, ext);
			}
		}
	}

	return [...byId.values()];
}

export async function shutdownExtensionHost(): Promise<void> {
	console.log("[vscode-shim] Shutting down extension host");
	await deactivateAll();
	isInitialized = false;
}

export function updateWorkspacePath(workspacePath: string): void {
	setWorkspacePath(workspacePath);
}

export function getActiveExtensions(): Array<{ id: string; isActive: boolean }> {
	return getLoadedExtensions().map((ext) => ({
		id: ext.info.id,
		isActive: ext.info.isActive,
	}));
}

export { isInitialized as isExtensionHostInitialized };
