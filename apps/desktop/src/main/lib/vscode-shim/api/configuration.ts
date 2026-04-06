/**
 * VS Code workspace configuration shim.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionManifest } from "../types.js";
import { EventEmitter } from "./event-emitter.js";

interface ConfigurationChangeEvent {
	affectsConfiguration(section: string, _scope?: unknown): boolean;
}

const _onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
export const onDidChangeConfiguration = _onDidChangeConfiguration.event;

function getUserDataPath(): string {
	try {
		const { app } = require("electron");
		return app.getPath("userData");
	} catch {
		return path.join(require("node:os").homedir(), ".superset-desktop");
	}
}

const configFilePath = path.join(
	getUserDataPath(),
	"vscode-extension-settings.json",
);

let configData: Record<string, unknown> = {};

function loadConfig(): void {
	try {
		if (fs.existsSync(configFilePath)) {
			configData = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
		}
	} catch {
		configData = {};
	}
}

function saveConfig(): void {
	try {
		fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
		fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2));
	} catch (err) {
		console.error("[vscode-shim] Failed to save config:", err);
	}
}

loadConfig();

/** Merge defaults from extension contributes.configuration into config */
export function registerExtensionDefaults(manifest: ExtensionManifest): void {
	const configs = manifest.contributes?.configuration;
	if (!configs) return;
	const schemas = Array.isArray(configs) ? configs : [configs];
	for (const schema of schemas) {
		if (!schema.properties) continue;
		for (const [key, prop] of Object.entries(schema.properties)) {
			if (prop.default !== undefined && configData[key] === undefined) {
				configData[key] = prop.default;
			}
		}
	}
}

class WorkspaceConfiguration {
	private _section: string;

	constructor(section: string) {
		this._section = section;
	}

	get<T>(key: string, defaultValue?: T): T {
		const fullKey = this._section ? `${this._section}.${key}` : key;
		const value = configData[fullKey];
		return (value !== undefined ? value : defaultValue) as T;
	}

	has(key: string): boolean {
		const fullKey = this._section ? `${this._section}.${key}` : key;
		return fullKey in configData;
	}

	inspect<T>(
		key: string,
	): { key: string; defaultValue?: T; globalValue?: T } | undefined {
		const fullKey = this._section ? `${this._section}.${key}` : key;
		return {
			key: fullKey,
			globalValue: configData[fullKey] as T | undefined,
		};
	}

	async update(
		key: string,
		value: unknown,
		_configurationTarget?: unknown,
		_overrideInLanguage?: boolean,
	): Promise<void> {
		const fullKey = this._section ? `${this._section}.${key}` : key;
		configData[fullKey] = value;
		saveConfig();
		_onDidChangeConfiguration.fire({
			affectsConfiguration(section: string) {
				return fullKey.startsWith(section);
			},
		});
	}
}

export function getConfiguration(
	section?: string,
	_scope?: unknown,
): WorkspaceConfiguration {
	return new WorkspaceConfiguration(section ?? "");
}
