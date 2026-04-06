/**
 * Extension loader: discovers, loads, and activates VS Code extensions.
 *
 * Intercepts `require('vscode')` via Module._resolveFilename so that
 * extensions receive our shim instead of the real VS Code API.
 */

import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { registerExtensionDefaults } from "./api/configuration.js";
import {
	createExtensionContext,
	type VscodeExtensionContext,
} from "./api/extension-context.js";
import type { ExtensionInfo, ExtensionManifest } from "./types.js";
import { createVscodeApi } from "./vscode-api.js";

const vscodeApi = createVscodeApi();
let interceptInstalled = false;

function installRequireIntercept(): void {
	if (interceptInstalled) return;
	interceptInstalled = true;

	// Inject vscode shim into require cache so require('vscode') returns our API.
	// We use _resolveFilename to redirect 'vscode' to a known cache key,
	// and pre-populate the cache with our shim module.
	const VSCODE_CACHE_KEY = path.join(__dirname, "__vscode_shim_module__.js");

	// Pre-populate the require cache
	require.cache[VSCODE_CACHE_KEY] = {
		id: VSCODE_CACHE_KEY,
		filename: VSCODE_CACHE_KEY,
		loaded: true,
		exports: vscodeApi,
		children: [],
		paths: [],
		path: __dirname,
		parent: null,
		require,
		isPreloading: false,
	} as unknown as NodeModule;

	const originalResolveFilename = (
		Module as unknown as { _resolveFilename: Function }
	)._resolveFilename;
	(Module as unknown as { _resolveFilename: Function })._resolveFilename =
		function (
			request: string,
			parent: unknown,
			isMain: boolean,
			options: unknown,
		) {
			if (request === "vscode") {
				return VSCODE_CACHE_KEY;
			}
			return originalResolveFilename.call(
				this,
				request,
				parent,
				isMain,
				options,
			);
		};
}

export function discoverExtensions(extensionsDir: string): ExtensionInfo[] {
	if (!fs.existsSync(extensionsDir)) return [];

	const results: ExtensionInfo[] = [];
	const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const extPath = path.join(extensionsDir, entry.name);
		const manifestPath = path.join(extPath, "package.json");

		if (!fs.existsSync(manifestPath)) continue;

		try {
			const manifest: ExtensionManifest = JSON.parse(
				fs.readFileSync(manifestPath, "utf-8"),
			);
			if (!manifest.main) continue;

			const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
			results.push({
				id,
				extensionPath: extPath,
				manifest,
				isActive: false,
			});
		} catch (err) {
			console.warn(`[vscode-shim] Failed to parse ${manifestPath}:`, err);
		}
	}

	return results;
}

interface LoadedExtension {
	info: ExtensionInfo;
	context: VscodeExtensionContext;
	exports: Record<string, unknown>;
}

const loadedExtensions = new Map<string, LoadedExtension>();

export async function loadExtension(
	info: ExtensionInfo,
): Promise<LoadedExtension> {
	if (loadedExtensions.has(info.id)) {
		return loadedExtensions.get(info.id)!;
	}

	installRequireIntercept();

	// Register default configuration values
	registerExtensionDefaults(info.manifest);

	// Create extension context
	const context = createExtensionContext(
		info.id,
		info.extensionPath,
		info.manifest,
	);

	// Load the extension's main module
	const mainPath = path.resolve(info.extensionPath, info.manifest.main!);
	console.log(`[vscode-shim] Loading extension: ${info.id} from ${mainPath}`);

	let extensionModule: Record<string, unknown>;
	try {
		extensionModule = require(mainPath);
	} catch (err) {
		console.error(`[vscode-shim] Failed to require ${info.id}:`, err);
		throw err;
	}

	// Activate the extension
	if (typeof extensionModule.activate === "function") {
		console.log(`[vscode-shim] Activating extension: ${info.id}`);
		try {
			await extensionModule.activate(context);
			info.isActive = true;
			console.log(`[vscode-shim] Extension activated: ${info.id}`);
		} catch (err) {
			console.error(`[vscode-shim] Failed to activate ${info.id}:`, err);
			throw err;
		}
	}

	const loaded: LoadedExtension = {
		info,
		context,
		exports: extensionModule,
	};

	loadedExtensions.set(info.id, loaded);
	return loaded;
}

export async function deactivateExtension(extensionId: string): Promise<void> {
	const loaded = loadedExtensions.get(extensionId);
	if (!loaded) return;

	if (typeof loaded.exports.deactivate === "function") {
		try {
			await loaded.exports.deactivate();
		} catch (err) {
			console.error(`[vscode-shim] Failed to deactivate ${extensionId}:`, err);
		}
	}

	// Dispose all subscriptions
	for (const sub of loaded.context.subscriptions) {
		try {
			sub.dispose();
		} catch {}
	}

	loaded.info.isActive = false;
	loadedExtensions.delete(extensionId);
}

export async function deactivateAll(): Promise<void> {
	for (const id of [...loadedExtensions.keys()]) {
		await deactivateExtension(id);
	}
}

export function getLoadedExtension(
	extensionId: string,
): LoadedExtension | undefined {
	return loadedExtensions.get(extensionId);
}

export function getLoadedExtensions(): LoadedExtension[] {
	return [...loadedExtensions.values()];
}
