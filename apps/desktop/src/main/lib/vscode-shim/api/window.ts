/**
 * VS Code window API shim.
 */

import type { WorkerToMainMessage } from "../ipc-types";
import { shimLog, shimWarn } from "./debug-log";
import { Disposable, type Event, EventEmitter } from "./event-emitter";
import { createOutputChannel, type OutputChannel } from "./output-channel";
import {
	createTerminal as createTerminalImpl,
	getActiveTerminal,
	getTerminals,
	terminalEvents,
} from "./terminal-shim";
import { Uri } from "./uri";
import {
	createWebviewPanel,
	registerWebviewPanelSerializer,
	registerWebviewViewProvider,
	type WebviewOptions,
	type WebviewPanel,
} from "./webview";

interface TextEditor {
	readonly document: {
		uri: Uri;
		fileName: string;
		getText(range?: unknown): string;
		languageId: string;
	};
	readonly selection: {
		readonly start: { line: number; character: number };
		readonly end: { line: number; character: number };
		readonly isEmpty: boolean;
		readonly active: { line: number; character: number };
	};
	readonly selections: Array<unknown>;
	readonly viewColumn: number | undefined;
}

interface Terminal {
	readonly name: string;
	readonly processId: Promise<number | undefined>;
	sendText(text: string, addNewLine?: boolean): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
	dispose(): void;
	readonly exitStatus: { code: number | undefined } | undefined;
	readonly shellIntegration?: {
		executeCommand(command: string): {
			execution: { commandLine: string };
			read(): AsyncIterable<string>;
		};
	};
}

// Minimal stubs for activeTextEditor and visible editors
const _onDidChangeActiveTextEditor = new EventEmitter<TextEditor | undefined>();
const _onDidChangeVisibleTextEditors = new EventEmitter<TextEditor[]>();
const _onDidChangeTextEditorSelection = new EventEmitter<unknown>();

// Emits when showTextDocument is called - renderer listens to open file viewer
const _openFileEmitter = new EventEmitter<{
	filePath: string;
	line?: number;
}>();
export const onOpenFile = _openFileEmitter.event;

// Emits when vscode.diff is called - renderer listens to open diff viewer
const _openDiffEmitter = new EventEmitter<{
	leftUri: string;
	rightUri: string;
	title?: string;
}>();
export const onOpenDiff = _openDiffEmitter.event;
export function fireOpenDiff(
	leftUri: string,
	rightUri: string,
	title?: string,
): void {
	_openDiffEmitter.fire({ leftUri, rightUri, title });
}

// IPC send function — injected from worker process so dialog calls go via main
let _sendToMain: ((msg: WorkerToMainMessage) => void) | null = null;
export function setSendToMain(fn: (msg: WorkerToMainMessage) => void): void {
	_sendToMain = fn;
}

// Pending dialog requests waiting for main-process response
const _pendingDialogs = new Map<string, (result: unknown) => void>();
export function resolveDialogResult(
	requestId: string,
	selectedIndex: number,
): void {
	_pendingDialogs.get(requestId)?.(selectedIndex);
	_pendingDialogs.delete(requestId);
}
export function resolveOpenDialogResult(
	requestId: string,
	filePaths: string[] | null,
): void {
	_pendingDialogs.get(requestId)?.(filePaths);
	_pendingDialogs.delete(requestId);
}

async function showMessageViaIpc(
	method: "showInformationMessage" | "showWarningMessage" | "showErrorMessage",
	message: string,
	items: string[],
): Promise<string | undefined> {
	if (!_sendToMain) return undefined;
	const requestId = crypto.randomUUID();
	const selectedIndex = await new Promise<number>((resolve) => {
		_pendingDialogs.set(requestId, (v) => resolve(v as number));
		_sendToMain?.({ type: "show-dialog", requestId, method, message, items });
	});
	if (selectedIndex < 0) return undefined;
	return items[selectedIndex];
}

// Active text editor state — updated from renderer via tRPC
let _activeTextEditor: TextEditor | undefined;
const _visibleTextEditors: TextEditor[] = [];

/** Called from tRPC when the focused file-viewer pane changes */
export function setActiveTextEditor(
	filePath: string | null,
	languageId?: string,
): void {
	const previous = _activeTextEditor;

	if (!filePath) {
		_activeTextEditor = undefined;
	} else {
		const uri = Uri.file(filePath);
		_activeTextEditor = {
			document: {
				uri,
				fileName: filePath,
				getText() {
					try {
						return require("node:fs").readFileSync(filePath, "utf-8");
					} catch {
						return "";
					}
				},
				languageId: languageId ?? "plaintext",
			},
			selection: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
				isEmpty: true,
				active: { line: 0, character: 0 },
			},
			selections: [],
			viewColumn: 1,
		};
		// Update visible editors
		_visibleTextEditors.length = 0;
		_visibleTextEditors.push(_activeTextEditor);
	}

	if (previous !== _activeTextEditor) {
		_onDidChangeActiveTextEditor.fire(_activeTextEditor);
		_onDidChangeVisibleTextEditors.fire([..._visibleTextEditors]);
		if (_activeTextEditor) {
			_onDidChangeTextEditorSelection.fire({
				textEditor: _activeTextEditor,
				selections: [_activeTextEditor.selection],
				kind: 1,
			});
		}
	}
}

// URI handlers for deep-link activation (e.g., ChatGPT OAuth)
const uriHandlers: Array<{ handleUri(uri: Uri): void }> = [];

/** Called from Electron's open-url handler to dispatch URIs to extensions */
export function handleUri(uri: Uri): void {
	for (const handler of uriHandlers) {
		try {
			handler.handleUri(uri);
		} catch (err) {
			console.error("[vscode-shim] URI handler error:", err);
		}
	}
}

// Terminal events are delegated to terminal-shim.ts

export const window = {
	// Text editor
	get activeTextEditor(): TextEditor | undefined {
		return _activeTextEditor;
	},

	get visibleTextEditors(): TextEditor[] {
		return [..._visibleTextEditors];
	},

	get activeTerminal(): Terminal | undefined {
		return getActiveTerminal() as Terminal | undefined;
	},

	get terminals(): Terminal[] {
		return getTerminals() as Terminal[];
	},

	onDidChangeActiveTextEditor: _onDidChangeActiveTextEditor.event,
	onDidChangeVisibleTextEditors: _onDidChangeVisibleTextEditors.event,
	onDidChangeTextEditorSelection: _onDidChangeTextEditorSelection.event,
	onDidOpenTerminal: terminalEvents.onDidOpenTerminal,
	onDidCloseTerminal: terminalEvents.onDidCloseTerminal,
	onDidChangeActiveTerminal: terminalEvents.onDidChangeActiveTerminal,
	onDidEndTerminalShellExecution: terminalEvents.onDidEndTerminalShellExecution,
	onDidChangeTerminalShellIntegration:
		terminalEvents.onDidChangeTerminalShellIntegration,
	onDidChangeWindowState: new EventEmitter<{ focused: boolean }>().event,
	state: { focused: true, active: true },

	// Tab groups
	tabGroups: {
		all: [] as Array<{
			tabs: unknown[];
			isActive: boolean;
			viewColumn: number;
		}>,
		get activeTabGroup() {
			return { tabs: [], isActive: true, viewColumn: 1 };
		},
		onDidChangeTabGroups: new EventEmitter<unknown>().event,
		onDidChangeTabs: new EventEmitter<unknown>().event,
		close(_tab: unknown): Promise<boolean> {
			return Promise.resolve(true);
		},
	},

	// Messages — sent via IPC to main process (Worker cannot access Electron dialog directly)
	async showInformationMessage(
		message: string,
		...items: string[]
	): Promise<string | undefined> {
		if (items.length === 0) {
			shimLog(`[vscode-shim] INFO: ${message}`);
			return undefined;
		}
		return showMessageViaIpc("showInformationMessage", message, items);
	},

	async showWarningMessage(
		message: string,
		...items: string[]
	): Promise<string | undefined> {
		if (items.length === 0) {
			shimWarn(`[vscode-shim] WARN: ${message}`);
			return undefined;
		}
		return showMessageViaIpc("showWarningMessage", message, items);
	},

	async showErrorMessage(
		message: string,
		...items: string[]
	): Promise<string | undefined> {
		if (items.length === 0) {
			console.error(`[vscode-shim] ERROR: ${message}`);
			return undefined;
		}
		return showMessageViaIpc("showErrorMessage", message, items);
	},

	async showQuickPick(
		items:
			| string[]
			| Array<{ label: string; description?: string; detail?: string }>
			| Promise<
					| string[]
					| Array<{ label: string; description?: string; detail?: string }>
			  >,
		options?: { placeHolder?: string; canPickMany?: boolean },
	): Promise<string | { label: string } | undefined> {
		const resolved = await items;
		if (!resolved || resolved.length === 0) return undefined;
		const labels = resolved.map((item) =>
			typeof item === "string" ? item : item.label,
		);
		if (!_sendToMain) {
			shimWarn("[vscode-shim] showQuickPick: no IPC channel available");
			return undefined;
		}
		const requestId = crypto.randomUUID();
		const selectedIndex = await new Promise<number>((resolve) => {
			_pendingDialogs.set(requestId, (v) => resolve(v as number));
			_sendToMain?.({
				type: "show-quickpick",
				requestId,
				labels,
				placeHolder: options?.placeHolder,
			});
		});
		if (selectedIndex < 0) return undefined;
		return resolved[selectedIndex];
	},

	async showInputBox(_options?: {
		prompt?: string;
		value?: string;
		placeHolder?: string;
	}): Promise<string | undefined> {
		shimWarn("[vscode-shim] showInputBox stub");
		return undefined;
	},

	async showOpenDialog(options?: {
		canSelectFiles?: boolean;
		canSelectFolders?: boolean;
		canSelectMany?: boolean;
		title?: string;
		filters?: Record<string, string[]>;
		defaultUri?: Uri;
	}): Promise<Uri[] | undefined> {
		if (!_sendToMain) {
			shimWarn("[vscode-shim] showOpenDialog: no IPC channel available");
			return undefined;
		}
		const filters = options?.filters
			? Object.entries(options.filters).map(([name, extensions]) => ({
					name,
					extensions,
				}))
			: undefined;
		const requestId = crypto.randomUUID();
		const filePaths = await new Promise<string[] | null>((resolve) => {
			_pendingDialogs.set(requestId, (v) => resolve(v as string[] | null));
			_sendToMain?.({
				type: "show-open-dialog",
				requestId,
				canSelectFiles: options?.canSelectFiles,
				canSelectFolders: options?.canSelectFolders,
				canSelectMany: options?.canSelectMany,
				title: options?.title,
				filters,
				defaultPath: options?.defaultUri?.fsPath,
			});
		});
		if (!filePaths || filePaths.length === 0) return undefined;
		return filePaths.map((p) => Uri.file(p));
	},

	async showTextDocument(
		document: { uri: Uri } | Uri,
		_options?: unknown,
	): Promise<TextEditor | undefined> {
		const uri =
			"uri" in (document as object)
				? (document as { uri: Uri }).uri
				: (document as Uri);
		shimLog(`[vscode-shim] showTextDocument: ${uri.toString()}`);

		// Notify renderer to open the file in file viewer
		if (uri.scheme === "file" && uri.fsPath) {
			_openFileEmitter.fire({
				filePath: uri.fsPath,
				line: (_options as { selection?: { start?: { line?: number } } })
					?.selection?.start?.line,
			});
		}

		// Return a minimal editor stub
		return {
			document: {
				uri,
				fileName: uri.fsPath,
				getText() {
					return "";
				},
				languageId: "plaintext",
			},
			selection: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
				isEmpty: true,
				active: { line: 0, character: 0 },
			},
			selections: [],
			viewColumn: 1,
		};
	},

	withProgress<T>(
		_options: { location: number; title?: string; cancellable?: boolean },
		task: (
			progress: {
				report(value: { message?: string; increment?: number }): void;
			},
			token: {
				isCancellationRequested: boolean;
				onCancellationRequested: Event<void>;
			},
		) => Promise<T>,
	): Promise<T> {
		const progress = {
			report(_value: { message?: string; increment?: number }) {
				// noop for now
			},
		};
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: new EventEmitter<void>().event,
		};
		return task(progress, token);
	},

	createOutputChannel(
		name: string,
		options?: { log: true } | string,
	): OutputChannel {
		return createOutputChannel(name, options);
	},

	createTerminal(
		nameOrOptions?:
			| string
			| {
					name?: string;
					cwd?: string;
					env?: Record<string, string | null>;
					shellPath?: string;
					shellArgs?: string[];
			  },
	): Terminal {
		return createTerminalImpl(nameOrOptions) as Terminal;
	},

	registerUriHandler(handler: { handleUri(uri: Uri): void }): Disposable {
		uriHandlers.push(handler);
		return new Disposable(() => {
			const idx = uriHandlers.indexOf(handler);
			if (idx >= 0) uriHandlers.splice(idx, 1);
		});
	},

	registerCustomEditorProvider(
		viewType: string,
		_provider: unknown,
		_options?: {
			webviewOptions?: { retainContextWhenHidden?: boolean };
			supportsMultipleEditorsPerDocument?: boolean;
		},
	): Disposable {
		shimLog(`[vscode-shim] registerCustomEditorProvider: ${viewType}`);
		return new Disposable(() => {});
	},

	createStatusBarItem(
		_alignmentOrId?: unknown,
		_priority?: number,
	): {
		text: string;
		tooltip: string;
		command: string | undefined;
		show(): void;
		hide(): void;
		dispose(): void;
	} {
		return {
			text: "",
			tooltip: "",
			command: undefined,
			show() {},
			hide() {},
			dispose() {},
		};
	},

	// Webview delegation
	registerWebviewViewProvider,
	registerWebviewPanelSerializer,

	createWebviewPanel(
		viewType: string,
		title: string,
		showOptions: number | { viewColumn: number; preserveFocus?: boolean },
		options?: WebviewOptions,
	): WebviewPanel {
		return createWebviewPanel(viewType, title, showOptions, "", options);
	},
};
