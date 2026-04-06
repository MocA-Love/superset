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

function getSafeStorage(): {
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	isEncryptionAvailable(): boolean;
} | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("electron").safeStorage as {
			encryptString(plainText: string): Buffer;
			decryptString(encrypted: Buffer): string;
			isEncryptionAvailable(): boolean;
		};
	} catch {
		return null;
	}
}

class SecretStorage {
	private _data = new Map<string, string>();
	private _onDidChange = new EventEmitter<{ key: string }>();
	private _filePath: string;
	readonly onDidChange: Event<{ key: string }> = this._onDidChange.event;

	constructor(filePath: string) {
		this._filePath = filePath;
		try {
			if (fs.existsSync(filePath)) {
				const raw = fs.readFileSync(filePath, "utf-8");
				const parsed = JSON.parse(raw) as Record<string, string>;
				const safeStorage = getSafeStorage();
				for (const [k, v] of Object.entries(parsed)) {
					try {
						if (safeStorage?.isEncryptionAvailable()) {
							const buf = Buffer.from(v, "base64");
							this._data.set(k, safeStorage.decryptString(buf));
						} else {
							this._data.set(k, v);
						}
					} catch {
						// If decryption fails (e.g. key changed), store as-is
						this._data.set(k, v);
					}
				}
			}
		} catch {}
	}

	private _persist(): void {
		try {
			const safeStorage = getSafeStorage();
			const obj: Record<string, string> = {};
			for (const [k, v] of this._data) {
				if (safeStorage?.isEncryptionAvailable()) {
					obj[k] = safeStorage.encryptString(v).toString("base64");
				} else {
					obj[k] = v;
				}
			}
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			fs.writeFileSync(this._filePath, JSON.stringify(obj, null, 2));
		} catch {}
	}

	async get(key: string): Promise<string | undefined> {
		return this._data.get(key);
	}

	async store(key: string, value: string): Promise<void> {
		this._data.set(key, value);
		this._persist();
		this._onDidChange.fire({ key });
	}

	async delete(key: string): Promise<void> {
		this._data.delete(key);
		this._persist();
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
		},
		append(variable: string, value: string) {
			vars.set(variable, { type: 2, value });
		},
		prepend(variable: string, value: string) {
			vars.set(variable, { type: 3, value });
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
		secrets: new SecretStorage(path.join(globalStoragePath, "secrets.json")),
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
