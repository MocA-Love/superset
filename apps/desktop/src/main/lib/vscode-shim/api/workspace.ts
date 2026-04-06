/**
 * VS Code workspace API shim.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfiguration, onDidChangeConfiguration } from "./configuration.js";
import { Disposable, type Event, EventEmitter } from "./event-emitter.js";
import { Uri } from "./uri.js";

interface WorkspaceFolder {
	readonly uri: Uri;
	readonly name: string;
	readonly index: number;
}

interface TextDocument {
	readonly uri: Uri;
	readonly fileName: string;
	readonly languageId: string;
	readonly version: number;
	readonly lineCount: number;
	getText(range?: unknown): string;
	save(): Promise<boolean>;
}

interface WorkspaceEdit {
	entries(): Array<[Uri, Array<{ range: unknown; newText: string }>]>;
}

interface FileSystemWatcher {
	readonly onDidCreate: Event<Uri>;
	readonly onDidChange: Event<Uri>;
	readonly onDidDelete: Event<Uri>;
	dispose(): void;
}

// Current workspace path — set via setWorkspacePath()
let workspaceFolderPath: string | undefined;
const _onDidChangeWorkspaceFolders = new EventEmitter<unknown>();
const _onDidChangeTextDocument = new EventEmitter<unknown>();
const _onDidOpenTextDocument = new EventEmitter<TextDocument>();
const _onDidCloseTextDocument = new EventEmitter<TextDocument>();
const _onWillSaveTextDocument = new EventEmitter<unknown>();

const fileSystemProviders = new Map<string, unknown>();
const textDocumentContentProviders = new Map<string, unknown>();

export function setWorkspacePath(folderPath: string): void {
	workspaceFolderPath = folderPath;
}

export const workspace = {
	get workspaceFolders(): WorkspaceFolder[] | undefined {
		if (!workspaceFolderPath) return undefined;
		return [
			{
				uri: Uri.file(workspaceFolderPath),
				name: path.basename(workspaceFolderPath),
				index: 0,
			},
		];
	},

	get rootPath(): string | undefined {
		return workspaceFolderPath;
	},

	get workspaceFile(): Uri | undefined {
		return undefined;
	},

	get textDocuments(): TextDocument[] {
		return [];
	},

	get name(): string | undefined {
		return workspaceFolderPath ? path.basename(workspaceFolderPath) : undefined;
	},

	onDidChangeWorkspaceFolders: _onDidChangeWorkspaceFolders.event,
	onDidChangeTextDocument: _onDidChangeTextDocument.event,
	onDidOpenTextDocument: _onDidOpenTextDocument.event,
	onDidCloseTextDocument: _onDidCloseTextDocument.event,
	onWillSaveTextDocument: _onWillSaveTextDocument.event,
	onDidChangeConfiguration,

	getConfiguration,

	getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
		if (!workspaceFolderPath) return undefined;
		if (uri.fsPath.startsWith(workspaceFolderPath)) {
			return {
				uri: Uri.file(workspaceFolderPath),
				name: path.basename(workspaceFolderPath),
				index: 0,
			};
		}
		return undefined;
	},

	asRelativePath(
		pathOrUri: string | Uri,
		_includeWorkspaceFolder?: boolean,
	): string {
		const p = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
		if (!workspaceFolderPath) return p;
		const rel = path.relative(workspaceFolderPath, p);
		if (rel.startsWith("..")) return p;
		return rel;
	},

	async openTextDocument(uriOrPath: Uri | string): Promise<TextDocument> {
		const filePath =
			typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath;
		const content = fs.existsSync(filePath)
			? fs.readFileSync(filePath, "utf-8")
			: "";
		const lines = content.split("\n");
		const ext = path.extname(filePath).slice(1);

		return {
			uri: Uri.file(filePath),
			fileName: filePath,
			languageId: ext || "plaintext",
			version: 1,
			lineCount: lines.length,
			getText(_range?: unknown) {
				return content;
			},
			async save() {
				return true;
			},
		};
	},

	async findFiles(
		_include: string,
		_exclude?: string | null,
		_maxResults?: number,
		_token?: unknown,
	): Promise<Uri[]> {
		// Simple glob-based file search using workspace root
		if (!workspaceFolderPath) return [];
		// For MVP, return empty array. In Phase 2+, wire to FsHostService.searchFiles
		console.warn(
			"[vscode-shim] workspace.findFiles is a stub, returning empty",
		);
		return [];
	},

	async applyEdit(_edit: WorkspaceEdit): Promise<boolean> {
		console.warn("[vscode-shim] workspace.applyEdit is a stub");
		return true;
	},

	createFileSystemWatcher(
		_globPattern: string,
		_ignoreCreateEvents?: boolean,
		_ignoreChangeEvents?: boolean,
		_ignoreDeleteEvents?: boolean,
	): FileSystemWatcher {
		const _onCreate = new EventEmitter<Uri>();
		const _onChange = new EventEmitter<Uri>();
		const _onDelete = new EventEmitter<Uri>();
		return {
			onDidCreate: _onCreate.event,
			onDidChange: _onChange.event,
			onDidDelete: _onDelete.event,
			dispose() {
				_onCreate.dispose();
				_onChange.dispose();
				_onDelete.dispose();
			},
		};
	},

	registerFileSystemProvider(
		scheme: string,
		provider: unknown,
		_options?: { isCaseSensitive?: boolean; isReadonly?: boolean },
	): Disposable {
		fileSystemProviders.set(scheme, provider);
		console.log(
			`[vscode-shim] Registered FileSystemProvider for scheme: ${scheme}`,
		);
		return new Disposable(() => {
			fileSystemProviders.delete(scheme);
		});
	},

	/** Get a registered file system provider (used by workspace.fs for custom schemes) */
	_getFileSystemProvider(scheme: string): unknown {
		return fileSystemProviders.get(scheme);
	},

	registerTextDocumentContentProvider(
		scheme: string,
		provider: unknown,
	): Disposable {
		textDocumentContentProviders.set(scheme, provider);
		return new Disposable(() => {
			textDocumentContentProviders.delete(scheme);
		});
	},

	fs: {
		async readFile(uri: Uri): Promise<Uint8Array> {
			// Check custom FS providers for non-file schemes
			if (uri.scheme !== "file") {
				const provider = fileSystemProviders.get(uri.scheme) as
					| { readFile?(uri: Uri): Promise<Uint8Array> }
					| undefined;
				if (provider?.readFile) {
					return provider.readFile(uri);
				}
				throw new Error(`No file system provider for scheme: ${uri.scheme}`);
			}
			return fs.promises.readFile(uri.fsPath);
		},
		async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
			await fs.promises.writeFile(uri.fsPath, content);
		},
		async stat(uri: Uri): Promise<{
			type: number;
			ctime: number;
			mtime: number;
			size: number;
		}> {
			if (uri.scheme !== "file") {
				const provider = fileSystemProviders.get(uri.scheme) as
					| {
							stat?(uri: Uri): Promise<{
								type: number;
								ctime: number;
								mtime: number;
								size: number;
							}>;
					  }
					| undefined;
				if (provider?.stat) {
					return provider.stat(uri);
				}
				return { type: 1, ctime: 0, mtime: 0, size: 0 };
			}
			const s = await fs.promises.stat(uri.fsPath);
			return {
				type: s.isDirectory() ? 2 : 1,
				ctime: s.ctimeMs,
				mtime: s.mtimeMs,
				size: s.size,
			};
		},
		async delete(
			uri: Uri,
			_options?: { recursive?: boolean; useTrash?: boolean },
		): Promise<void> {
			await fs.promises.rm(uri.fsPath, { recursive: _options?.recursive });
		},
		async rename(
			source: Uri,
			target: Uri,
			_options?: { overwrite?: boolean },
		): Promise<void> {
			await fs.promises.rename(source.fsPath, target.fsPath);
		},
		async createDirectory(uri: Uri): Promise<void> {
			await fs.promises.mkdir(uri.fsPath, { recursive: true });
		},
		async copy(
			source: Uri,
			target: Uri,
			_options?: { overwrite?: boolean },
		): Promise<void> {
			await fs.promises.copyFile(source.fsPath, target.fsPath);
		},
		isWritableFileSystem(scheme: string): boolean | undefined {
			return scheme === "file" ? true : undefined;
		},
	},
};
