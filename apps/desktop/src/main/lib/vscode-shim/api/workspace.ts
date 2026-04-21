/**
 * VS Code workspace API shim.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfiguration, onDidChangeConfiguration } from "./configuration";
import { shimLog, shimWarn } from "./debug-log";
import { Disposable, type Event, EventEmitter } from "./event-emitter";
import { Uri } from "./uri";

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
	readonly isDirty: boolean;
	readonly isUntitled: boolean;
	getText(range?: unknown): string;
	save(): Promise<boolean>;
}

interface TextEditRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

interface WorkspaceEdit {
	entries(): Array<[Uri, Array<{ range: TextEditRange; newText: string }>]>;
}

interface FileSystemWatcher {
	readonly onDidCreate: Event<Uri>;
	readonly onDidChange: Event<Uri>;
	readonly onDidDelete: Event<Uri>;
	dispose(): void;
}

// Current workspace path — set via setWorkspacePath()
let workspaceFolderPath: string | undefined;
const _onDidChangeWorkspaceFolders = new EventEmitter<{
	added: Array<{ uri: Uri; name: string; index: number }>;
	removed: Array<{ uri: Uri; name: string; index: number }>;
}>();
const _onDidChangeTextDocument = new EventEmitter<unknown>();
const _onDidOpenTextDocument = new EventEmitter<TextDocument>();
const _onDidCloseTextDocument = new EventEmitter<TextDocument>();
const _onWillSaveTextDocument = new EventEmitter<unknown>();
const _textDocuments: TextDocument[] = [];

const fileSystemProviders = new Map<string, unknown>();
const textDocumentContentProviders = new Map<string, unknown>();
const DEFAULT_FIND_EXCLUDE_GLOBS = ["**/.git", "**/node_modules"];
const FILE_TYPE = {
	File: 1,
	Directory: 2,
	SymbolicLink: 64,
} as const;

function normalizeGlobPath(value: string): string {
	return value.split(path.sep).join("/");
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
	let source = "^";

	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];

		if (char === "\\") {
			const next = glob[index + 1];
			if (next) {
				source += escapeRegexLiteral(next);
				index += 1;
			} else {
				source += "\\\\";
			}
			continue;
		}

		if (char === "*") {
			if (glob[index + 1] === "*") {
				while (glob[index + 1] === "*") {
					index += 1;
				}
				if (glob[index + 1] === "/") {
					source += "(?:.*/)?";
					index += 1;
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			continue;
		}

		if (char === "[") {
			const closingIndex = glob.indexOf("]", index + 1);
			if (closingIndex === -1) {
				source += "\\[";
			} else {
				source += glob.slice(index, closingIndex + 1);
				index = closingIndex;
			}
			continue;
		}

		source += escapeRegexLiteral(char);
	}

	source += "$";
	return new RegExp(source);
}

function findFirstBraceRange(
	pattern: string,
): { start: number; end: number; body: string } | null {
	let braceStart = -1;
	let depth = 0;

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "{") {
			if (depth === 0) {
				braceStart = index;
			}
			depth += 1;
			continue;
		}
		if (char === "}") {
			if (depth === 0 || braceStart < 0) {
				continue;
			}
			depth -= 1;
			if (depth === 0) {
				return {
					start: braceStart,
					end: index,
					body: pattern.slice(braceStart + 1, index),
				};
			}
		}
	}

	return null;
}

function splitBraceOptions(body: string): string[] {
	const options: string[] = [];
	let depth = 0;
	let current = "";

	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "\\") {
			current += char;
			if (index + 1 < body.length) {
				current += body[index + 1];
				index += 1;
			}
			continue;
		}
		if (char === "{") {
			depth += 1;
			current += char;
			continue;
		}
		if (char === "}") {
			depth = Math.max(0, depth - 1);
			current += char;
			continue;
		}
		if (char === "," && depth === 0) {
			options.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	options.push(current);
	return options;
}

function expandBracePatterns(pattern: string): string[] {
	const braceRange = findFirstBraceRange(pattern);
	if (!braceRange) {
		return [pattern];
	}

	const prefix = pattern.slice(0, braceRange.start);
	const suffix = pattern.slice(braceRange.end + 1);
	const options = splitBraceOptions(braceRange.body);

	return options.flatMap((option) =>
		expandBracePatterns(`${prefix}${option}${suffix}`),
	);
}

function compileGlobPatterns(pattern: string | null | undefined): string[] {
	if (!pattern) {
		return [];
	}

	const normalized = pattern.trim();
	if (!normalized) {
		return [];
	}

	return expandBracePatterns(normalized)
		.map((entry) => normalizeGlobPath(entry.trim()))
		.filter(Boolean);
}

function compileGlobMatchers(pattern: string | null | undefined): RegExp[] {
	const patterns = compileGlobPatterns(pattern);

	return patterns.map((entry) => globToRegExp(entry));
}

function matchesAnyGlob(matchers: RegExp[], targetPath: string): boolean {
	if (matchers.length === 0) {
		return false;
	}

	const normalizedTarget = normalizeGlobPath(targetPath);
	return matchers.some((matcher) => matcher.test(normalizedTarget));
}

function splitGlobSegments(pattern: string): string[] {
	return normalizeGlobPath(pattern)
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function hasGlobMeta(segment: string): boolean {
	let escaped = false;

	for (const char of segment) {
		if (!escaped && char === "\\") {
			escaped = true;
			continue;
		}
		if (!escaped && (char === "*" || char === "?" || char === "[")) {
			return true;
		}
		escaped = false;
	}

	return false;
}

function getStaticGlobPrefixSegments(pattern: string): string[] {
	const prefix: string[] = [];

	for (const segment of splitGlobSegments(pattern)) {
		if (segment === "**" || hasGlobMeta(segment)) {
			break;
		}
		prefix.push(segment);
	}

	return prefix;
}

function directoryMayContainMatches(
	relativeDirectory: string,
	includePatterns: string[],
): boolean {
	if (includePatterns.length === 0) {
		return true;
	}

	const directorySegments = splitGlobSegments(relativeDirectory);

	return includePatterns.some((pattern) => {
		const prefixSegments = getStaticGlobPrefixSegments(pattern);
		if (prefixSegments.length === 0) {
			return true;
		}

		const commonLength = Math.min(
			directorySegments.length,
			prefixSegments.length,
		);
		for (let index = 0; index < commonLength; index += 1) {
			if (directorySegments[index] !== prefixSegments[index]) {
				return false;
			}
		}

		return true;
	});
}

export async function resolveTextDocumentContent(
	uri: Uri,
): Promise<string | undefined> {
	if (uri.scheme === "file") {
		try {
			return await fs.promises.readFile(uri.fsPath, "utf-8");
		} catch {
			return undefined;
		}
	}

	const provider = textDocumentContentProviders.get(uri.scheme) as
		| {
				provideTextDocumentContent?(
					uri: Uri,
				): string | undefined | Promise<string | undefined>;
		  }
		| undefined;
	if (!provider?.provideTextDocumentContent) {
		return undefined;
	}

	const content = await provider.provideTextDocumentContent(uri);
	return typeof content === "string" ? content : undefined;
}

export function setWorkspacePath(folderPath: string): void {
	const oldPath = workspaceFolderPath;
	workspaceFolderPath = folderPath;

	if (oldPath !== folderPath) {
		_onDidChangeWorkspaceFolders.fire({
			added: folderPath
				? [
						{
							uri: Uri.file(folderPath),
							name: path.basename(folderPath),
							index: 0,
						},
					]
				: [],
			removed: oldPath
				? [{ uri: Uri.file(oldPath), name: path.basename(oldPath), index: 0 }]
				: [],
		});
	}
}

export function setActiveWorkspaceTextDocument(
	filePath: string | null,
	languageId?: string,
): void {
	_textDocuments.length = 0;
	if (!filePath) {
		return;
	}

	const readContent = () => {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return "";
		}
	};

	const content = readContent();
	const doc: TextDocument = {
		uri: Uri.file(filePath),
		fileName: filePath,
		languageId: languageId ?? (path.extname(filePath).slice(1) || "plaintext"),
		version: 1,
		lineCount: content.split("\n").length,
		isDirty: false,
		isUntitled: false,
		getText() {
			return readContent();
		},
		async save() {
			return true;
		},
	};
	_textDocuments.push(doc);
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
		return [..._textDocuments];
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
		const uri = typeof uriOrPath === "string" ? Uri.file(uriOrPath) : uriOrPath;
		const filePath = uri.scheme === "file" ? uri.fsPath : uri.path;
		const content = (await resolveTextDocumentContent(uri)) ?? "";
		const lines = content.split("\n");
		const ext = path.extname(filePath).slice(1);

		return {
			uri,
			fileName: filePath,
			languageId: ext || "plaintext",
			version: 1,
			lineCount: lines.length,
			isDirty: false,
			isUntitled: false,
			getText(_range?: unknown) {
				return content;
			},
			async save() {
				return true;
			},
		};
	},

	async findFiles(
		include: string,
		exclude?: string | null,
		maxResults?: number,
		_token?: unknown,
	): Promise<Uri[]> {
		if (!workspaceFolderPath) return [];
		try {
			const results: string[] = [];
			const includePatterns = compileGlobPatterns(include);
			const includeMatchers = includePatterns.map((pattern) =>
				globToRegExp(pattern),
			);
			const excludeMatchers = compileGlobMatchers(
				exclude === undefined
					? `{${DEFAULT_FIND_EXCLUDE_GLOBS.join(",")}}`
					: exclude,
			);

			function walkDir(dir: string, depth: number): void {
				if (depth > 15 || (maxResults && results.length >= maxResults)) return;
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					const relativePath = normalizeGlobPath(
						path.relative(workspaceFolderPath, fullPath),
					);
					if (
						relativePath &&
						(matchesAnyGlob(excludeMatchers, relativePath) ||
							(entry.isDirectory() &&
								matchesAnyGlob(excludeMatchers, `${relativePath}/`)))
					) {
						continue;
					}
					if (entry.isDirectory()) {
						walkDir(fullPath, depth + 1);
					} else if (entry.isFile()) {
						if (
							includeMatchers.length === 0 ||
							matchesAnyGlob(includeMatchers, relativePath)
						) {
							results.push(fullPath);
						}
					}
					if (maxResults && results.length >= maxResults) return;
				}
			}

			walkDir(workspaceFolderPath, 0);
			return results.map((r) => Uri.file(r));
		} catch {
			shimWarn("[vscode-shim] workspace.findFiles failed, returning empty");
			return [];
		}
	},

	async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
		try {
			for (const [uri, textEdits] of edit.entries()) {
				if (uri.scheme !== "file" || !uri.fsPath || textEdits.length === 0)
					continue;
				const content = fs.readFileSync(uri.fsPath, "utf-8");
				const lines = content.split("\n");
				// 後ろから適用することでインデックスのずれを防ぐ
				const sorted = [...textEdits].sort((a, b) => {
					const dl = b.range.start.line - a.range.start.line;
					return dl !== 0
						? dl
						: b.range.start.character - a.range.start.character;
				});
				for (const te of sorted) {
					const { start, end } = te.range;
					if (start.line === end.line) {
						const line = lines[start.line] ?? "";
						const merged =
							line.slice(0, start.character) +
							te.newText +
							line.slice(end.character);
						lines.splice(start.line, 1, ...merged.split("\n"));
					} else {
						const startLine = lines[start.line] ?? "";
						const endLine = lines[end.line] ?? "";
						const merged =
							startLine.slice(0, start.character) +
							te.newText +
							endLine.slice(end.character);
						lines.splice(
							start.line,
							end.line - start.line + 1,
							...merged.split("\n"),
						);
					}
				}
				fs.writeFileSync(uri.fsPath, lines.join("\n"), "utf-8");
				shimLog(`[vscode-shim] workspace.applyEdit: wrote ${uri.fsPath}`);
			}
			return true;
		} catch (err) {
			shimWarn("[vscode-shim] workspace.applyEdit failed:", err);
			return false;
		}
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
		const rootPath = workspaceFolderPath;
		const includePatterns = compileGlobPatterns(_globPattern);
		const includeMatchers = includePatterns.map((pattern) =>
			globToRegExp(pattern),
		);
		const excludeMatchers = compileGlobMatchers(
			`{${DEFAULT_FIND_EXCLUDE_GLOBS.join(",")}}`,
		);
		const dirWatchers = new Map<string, fs.FSWatcher>();

		const matchesWatcherPath = (fullPath: string): boolean => {
			if (!rootPath) {
				return false;
			}
			const relativePath = normalizeGlobPath(path.relative(rootPath, fullPath));
			if (!relativePath || relativePath.startsWith("..")) {
				return false;
			}
			return (
				includeMatchers.length === 0 ||
				matchesAnyGlob(includeMatchers, relativePath) ||
				matchesAnyGlob(includeMatchers, `${relativePath}/`)
			);
		};

		const shouldSkipDirectory = (directoryPath: string): boolean => {
			if (!rootPath) {
				return false;
			}
			const relativePath = normalizeGlobPath(
				path.relative(rootPath, directoryPath),
			);
			if (!relativePath || relativePath.startsWith("..")) {
				return false;
			}
			return (
				matchesAnyGlob(excludeMatchers, relativePath) ||
				matchesAnyGlob(excludeMatchers, `${relativePath}/`) ||
				!directoryMayContainMatches(relativePath, includePatterns)
			);
		};

		const closeDescendantWatchers = (targetPath: string) => {
			const watchedDirs = [...dirWatchers.keys()];
			for (const watchedDir of watchedDirs) {
				if (
					watchedDir === targetPath ||
					watchedDir.startsWith(`${targetPath}${path.sep}`)
				) {
					const watcher = dirWatchers.get(watchedDir);
					if (!watcher) {
						continue;
					}
					watcher.close();
					dirWatchers.delete(watchedDir);
				}
			}
		};

		const addDirectoryWatcher = (directoryPath: string) => {
			if (dirWatchers.has(directoryPath)) {
				return;
			}
			if (shouldSkipDirectory(directoryPath)) {
				return;
			}

			try {
				const watcher = fs.watch(directoryPath, (eventType, filename) => {
					if (!filename) {
						return;
					}

					const fullPath = path.join(directoryPath, filename.toString());
					const exists = fs.existsSync(fullPath);

					if (exists) {
						try {
							if (
								fs.statSync(fullPath).isDirectory() &&
								!shouldSkipDirectory(fullPath)
							) {
								addDirectoryWatcher(fullPath);
							}
						} catch {}
					} else {
						closeDescendantWatchers(fullPath);
					}

					if (!matchesWatcherPath(fullPath)) {
						return;
					}

					const uri = Uri.file(fullPath);
					if (!exists) {
						if (!_ignoreDeleteEvents) {
							_onDelete.fire(uri);
						}
						return;
					}

					if (eventType === "change") {
						if (!_ignoreChangeEvents) {
							_onChange.fire(uri);
						}
						return;
					}

					if (!_ignoreCreateEvents) {
						_onCreate.fire(uri);
					}
				});
				dirWatchers.set(directoryPath, watcher);
			} catch (error) {
				shimWarn(
					`[vscode-shim] createFileSystemWatcher failed for ${directoryPath}:`,
					error,
				);
				return;
			}

			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(directoryPath, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				addDirectoryWatcher(path.join(directoryPath, entry.name));
			}
		};

		if (rootPath) {
			addDirectoryWatcher(rootPath);
		}

		return {
			onDidCreate: _onCreate.event,
			onDidChange: _onChange.event,
			onDidDelete: _onDelete.event,
			dispose() {
				for (const watcher of dirWatchers.values()) {
					watcher.close();
				}
				dirWatchers.clear();
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
		shimLog(
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
		async readDirectory(uri: Uri): Promise<[string, number][]> {
			if (uri.scheme !== "file") {
				const provider = fileSystemProviders.get(uri.scheme) as
					| { readDirectory?(uri: Uri): Promise<[string, number][]> }
					| undefined;
				if (provider?.readDirectory) {
					return provider.readDirectory(uri);
				}
				throw new Error(`No file system provider for scheme: ${uri.scheme}`);
			}
			const entries = await fs.promises.readdir(uri.fsPath, {
				withFileTypes: true,
			});
			return Promise.all(
				entries.map(async (entry) => {
					if (entry.isDirectory()) {
						return [entry.name, FILE_TYPE.Directory] as [string, number];
					}

					if (!entry.isSymbolicLink()) {
						return [entry.name, FILE_TYPE.File] as [string, number];
					}

					const entryPath = path.join(uri.fsPath, entry.name);

					try {
						const stats = await fs.promises.stat(entryPath);
						return [
							entry.name,
							(stats.isDirectory() ? FILE_TYPE.Directory : FILE_TYPE.File) |
								FILE_TYPE.SymbolicLink,
						] as [string, number];
					} catch {
						return [entry.name, FILE_TYPE.SymbolicLink] as [string, number];
					}
				}),
			);
		},
		isWritableFileSystem(scheme: string): boolean | undefined {
			return scheme === "file" ? true : undefined;
		},
	},
};
