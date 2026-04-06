/**
 * VS Code ExtensionContext shim.
 */

import fs from "node:fs";
import path from "node:path";

function getUserDataPath(): string {
	try {
		return require("electron").app.getPath("userData");
	} catch {
		return require("node:path").join(
			require("node:os").homedir(),
			".superset-desktop",
		);
	}
}

import type { ExtensionManifest } from "../types";
import { type Disposable, type Event, EventEmitter } from "./event-emitter";
import { Uri } from "./uri";

class Memento {
	private _data: Record<string, unknown>;
	private _filePath: string;

	constructor(filePath: string) {
		this._filePath = filePath;
		try {
			this._data = fs.existsSync(filePath)
				? JSON.parse(fs.readFileSync(filePath, "utf-8"))
				: {};
		} catch {
			this._data = {};
		}
	}

	get<T>(key: string, defaultValue?: T): T {
		const val = this._data[key];
		return (val !== undefined ? val : defaultValue) as T;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			delete this._data[key];
		} else {
			this._data[key] = value;
		}
		fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
		fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2));
	}

	keys(): readonly string[] {
		return Object.keys(this._data);
	}
}

class SecretStorage {
	private _data = new Map<string, string>();
	private _onDidChange = new EventEmitter<{ key: string }>();
	readonly onDidChange: Event<{ key: string }> = this._onDidChange.event;

	async get(key: string): Promise<string | undefined> {
		return this._data.get(key);
	}

	async store(key: string, value: string): Promise<void> {
		this._data.set(key, value);
		this._onDidChange.fire({ key });
	}

	async delete(key: string): Promise<void> {
		this._data.delete(key);
		this._onDidChange.fire({ key });
	}
}

interface EnvironmentVariableCollection {
	persistent: boolean;
	description: string | undefined;
	replace(variable: string, value: string, options?: unknown): void;
	append(variable: string, value: string, options?: unknown): void;
	prepend(variable: string, value: string, options?: unknown): void;
	get(variable: string): unknown;
	delete(variable: string): void;
	clear(): void;
	forEach(
		callback: (variable: string, mutator: unknown, collection: unknown) => void,
	): void;
	[Symbol.iterator](): Iterator<[string, unknown]>;
}

function createEnvironmentVariableCollection(): EnvironmentVariableCollection {
	const vars = new Map<string, { type: number; value: string }>();
	return {
		persistent: true,
		description: undefined,
		replace(variable: string, value: string) {
			vars.set(variable, { type: 1, value });
			process.env[variable] = value;
		},
		append(variable: string, value: string) {
			vars.set(variable, { type: 2, value });
			process.env[variable] = (process.env[variable] ?? "") + value;
		},
		prepend(variable: string, value: string) {
			vars.set(variable, { type: 3, value });
			process.env[variable] = value + (process.env[variable] ?? "");
		},
		get(variable: string) {
			return vars.get(variable);
		},
		delete(variable: string) {
			vars.delete(variable);
		},
		clear() {
			vars.clear();
		},
		forEach(callback) {
			for (const [k, v] of vars) callback(k, v, this);
		},
		*[Symbol.iterator]() {
			yield* vars.entries();
		},
	};
}

export interface VscodeExtensionContext {
	subscriptions: Disposable[];
	extensionPath: string;
	extensionUri: Uri;
	globalState: Memento;
	workspaceState: Memento;
	secrets: SecretStorage;
	storagePath: string | undefined;
	globalStoragePath: string;
	logPath: string;
	extensionMode: number;
	environmentVariableCollection: EnvironmentVariableCollection;
	extension: {
		id: string;
		extensionPath: string;
		packageJSON: ExtensionManifest;
	};
	asAbsolutePath(relativePath: string): string;
}

export function createExtensionContext(
	extensionId: string,
	extensionPath: string,
	manifest: ExtensionManifest,
): VscodeExtensionContext {
	const storageBase = path.join(getUserDataPath(), "vscode-extensions");
	const globalStoragePath = path.join(storageBase, extensionId, "global");
	const storagePath = path.join(storageBase, extensionId, "workspace");
	const logPath = path.join(storageBase, extensionId, "logs");

	fs.mkdirSync(globalStoragePath, { recursive: true });
	fs.mkdirSync(storagePath, { recursive: true });
	fs.mkdirSync(logPath, { recursive: true });

	return {
		subscriptions: [],
		extensionPath,
		extensionUri: Uri.file(extensionPath),
		globalState: new Memento(path.join(globalStoragePath, "state.json")),
		workspaceState: new Memento(path.join(storagePath, "state.json")),
		secrets: new SecretStorage(),
		storagePath,
		globalStoragePath,
		logPath,
		extensionMode: 1,
		environmentVariableCollection: createEnvironmentVariableCollection(),
		extension: {
			id: extensionId,
			extensionPath,
			packageJSON: manifest,
		},
		asAbsolutePath(relativePath: string): string {
			return path.join(extensionPath, relativePath);
		},
	};
}
