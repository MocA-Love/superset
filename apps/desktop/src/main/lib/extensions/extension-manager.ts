import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, session } from "electron";
import type { CompatibilityReport } from "./compatibility-checker";
import { checkCompatibility } from "./compatibility-checker";
import {
	type ChromeManifest,
	type CrxDownloadResult,
	downloadAndExtractExtension,
	getExtensionsDir,
	parseExtensionId,
} from "./crx-downloader";

const APP_PARTITION = "persist:superset";

export interface InstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	enabled: boolean;
	installedAt: string;
	compatibility: CompatibilityReport;
	iconPath?: string;
}

interface ExtensionStore {
	extensions: InstalledExtension[];
}

function getStorePath(): string {
	return path.join(app.getPath("userData"), "extension-store.json");
}

async function readStore(): Promise<ExtensionStore> {
	const storePath = getStorePath();
	try {
		const data = await readFile(storePath, "utf-8");
		return JSON.parse(data) as ExtensionStore;
	} catch {
		return { extensions: [] };
	}
}

async function writeStore(store: ExtensionStore): Promise<void> {
	const storePath = getStorePath();
	await writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Resolve the best icon path from the manifest icons object.
 */
function resolveIconPath(
	manifest: ChromeManifest,
	extensionDir: string,
): string | undefined {
	if (!manifest.icons) return undefined;

	// Prefer larger icons
	const sizes = Object.keys(manifest.icons)
		.map(Number)
		.sort((a, b) => b - a);

	for (const size of sizes) {
		const iconRelPath = manifest.icons[String(size)];
		if (iconRelPath) {
			const fullPath = path.join(extensionDir, iconRelPath);
			if (existsSync(fullPath)) return fullPath;
		}
	}

	return undefined;
}

/**
 * Load all enabled extensions into the Electron session.
 * Called at app startup.
 */
export async function loadInstalledExtensions(): Promise<void> {
	const store = await readStore();
	const ses = session.fromPartition(APP_PARTITION);

	for (const ext of store.extensions) {
		if (!ext.enabled) continue;

		const extensionDir = path.join(getExtensionsDir(), ext.id);
		if (!existsSync(path.join(extensionDir, "manifest.json"))) {
			console.warn(
				`[extensions] Extension ${ext.id} (${ext.name}) directory missing, skipping`,
			);
			continue;
		}

		try {
			// Skip if already loaded
			if (ses.extensions.getExtension(ext.id)) continue;

			await ses.extensions.loadExtension(extensionDir);
			console.log(`[extensions] Loaded: ${ext.name} v${ext.version}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("already loaded")) continue;
			console.error(`[extensions] Failed to load ${ext.name}:`, error);
		}
	}
}

/**
 * Install an extension from the Chrome Web Store.
 */
export async function installExtension(input: string): Promise<InstalledExtension> {
	const extensionId = parseExtensionId(input);
	if (!extensionId) {
		throw new Error(
			"Invalid input. Please provide a Chrome Web Store URL or extension ID.",
		);
	}

	// Check if already installed
	const store = await readStore();
	const existing = store.extensions.find((e) => e.id === extensionId);
	if (existing) {
		throw new Error(`Extension "${existing.name}" is already installed.`);
	}

	// Download and extract
	const result = await downloadAndExtractExtension(extensionId);

	// Run compatibility check
	const compatibility = await checkCompatibility(
		result.extensionDir,
		result.manifest,
	);

	const iconPath = resolveIconPath(result.manifest, result.extensionDir);

	const installed: InstalledExtension = {
		id: extensionId,
		name: result.manifest.name,
		version: result.manifest.version,
		description: result.manifest.description ?? "",
		enabled: true,
		installedAt: new Date().toISOString(),
		compatibility,
		iconPath,
	};

	// Load into session
	const ses = session.fromPartition(APP_PARTITION);
	try {
		await ses.extensions.loadExtension(result.extensionDir);
		console.log(
			`[extensions] Installed and loaded: ${installed.name} v${installed.version}`,
		);
	} catch (error) {
		console.error(
			`[extensions] Installed but failed to load ${installed.name}:`,
			error,
		);
		installed.enabled = false;
	}

	// Persist
	store.extensions.push(installed);
	await writeStore(store);

	return installed;
}

/**
 * Uninstall an extension.
 */
export async function uninstallExtension(extensionId: string): Promise<void> {
	const store = await readStore();
	const idx = store.extensions.findIndex((e) => e.id === extensionId);
	if (idx === -1) {
		throw new Error("Extension not found.");
	}

	// Unload from session
	const ses = session.fromPartition(APP_PARTITION);
	try {
		ses.extensions.removeExtension(extensionId);
	} catch {
		// May not be loaded
	}

	// Remove files
	const extensionDir = path.join(getExtensionsDir(), extensionId);
	if (existsSync(extensionDir)) {
		await rm(extensionDir, { recursive: true, force: true });
	}

	// Update store
	store.extensions.splice(idx, 1);
	await writeStore(store);

	console.log(`[extensions] Uninstalled: ${extensionId}`);
}

/**
 * Toggle an extension's enabled state.
 */
export async function toggleExtension(
	extensionId: string,
	enabled: boolean,
): Promise<InstalledExtension> {
	const store = await readStore();
	const ext = store.extensions.find((e) => e.id === extensionId);
	if (!ext) {
		throw new Error("Extension not found.");
	}

	const ses = session.fromPartition(APP_PARTITION);

	if (enabled) {
		const extensionDir = path.join(getExtensionsDir(), extensionId);
		if (!existsSync(path.join(extensionDir, "manifest.json"))) {
			throw new Error("Extension files are missing. Please reinstall.");
		}
		try {
			if (!ses.extensions.getExtension(extensionId)) {
				await ses.extensions.loadExtension(extensionDir);
			}
		} catch (error) {
			throw new Error(
				`Failed to enable extension: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		try {
			ses.extensions.removeExtension(extensionId);
		} catch {
			// Already unloaded
		}
	}

	ext.enabled = enabled;
	await writeStore(store);

	return ext;
}

/**
 * List all installed extensions.
 */
export async function listExtensions(): Promise<InstalledExtension[]> {
	const store = await readStore();
	return store.extensions;
}

export interface ExtensionToolbarInfo {
	id: string;
	name: string;
	enabled: boolean;
	hasPopup: boolean;
	popupPath: string | null;
	actionTitle: string | null;
}

/**
 * Get toolbar-relevant info for all enabled extensions that have a popup action.
 */
export async function getExtensionsWithToolbarInfo(): Promise<
	ExtensionToolbarInfo[]
> {
	const store = await readStore();
	const results: ExtensionToolbarInfo[] = [];

	for (const ext of store.extensions) {
		if (!ext.enabled) continue;

		const extensionDir = path.join(getExtensionsDir(), ext.id);
		const manifestPath = path.join(extensionDir, "manifest.json");

		if (!existsSync(manifestPath)) continue;

		let manifest: ChromeManifest;
		try {
			const data = await readFile(manifestPath, "utf-8");
			manifest = JSON.parse(data) as ChromeManifest;
		} catch {
			continue;
		}

		const action = manifest.action ?? manifest.browser_action;
		const hasPopup = !!action?.default_popup;

		if (!hasPopup) continue;

		results.push({
			id: ext.id,
			name: ext.name,
			enabled: ext.enabled,
			hasPopup,
			popupPath: action?.default_popup ?? null,
			actionTitle: action?.default_title ?? null,
		});
	}

	return results;
}
