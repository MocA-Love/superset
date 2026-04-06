/**
 * VS Code window API shim.
 */

function getDialog(): typeof import("electron").dialog {
	try {
		return require("electron").dialog;
	} catch {
		return {
			showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
		} as unknown as typeof import("electron").dialog;
	}
}
import { Disposable, EventEmitter, type Event } from "./event-emitter.js";
import { Uri } from "./uri.js";
import { createOutputChannel, type OutputChannel } from "./output-channel.js";
import {
	createTerminal as createTerminalImpl,
	getTerminals,
	getActiveTerminal,
	terminalEvents,
} from "./terminal-shim.js";
import {
	registerWebviewViewProvider,
	registerWebviewPanelSerializer,
	createWebviewPanel,
	type WebviewViewProvider,
	type WebviewPanelSerializer,
	type WebviewOptions,
	type WebviewPanel,
} from "./webview.js";

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
		return undefined; // Will be connected to file-viewer state in Phase 4
	},

	get visibleTextEditors(): TextEditor[] {
		return [];
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
	onDidChangeTerminalShellIntegration: terminalEvents.onDidChangeTerminalShellIntegration,
	onDidChangeWindowState: new EventEmitter<{ focused: boolean }>().event,
	state: { focused: true, active: true },

	// Tab groups
	tabGroups: {
		all: [] as Array<{ tabs: unknown[]; isActive: boolean; viewColumn: number }>,
		get activeTabGroup() {
			return { tabs: [], isActive: true, viewColumn: 1 };
		},
		onDidChangeTabGroups: new EventEmitter<unknown>().event,
		onDidChangeTabs: new EventEmitter<unknown>().event,
		close(_tab: unknown): Promise<boolean> {
			return Promise.resolve(true);
		},
	},

	// Messages
	async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
		if (items.length === 0) {
			console.log(`[vscode-shim] INFO: ${message}`);
			return undefined;
		}
		const result = await getDialog().showMessageBox({
			type: "info",
			message,
			buttons: items,
		});
		return items[result.response];
	},

	async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
		if (items.length === 0) {
			console.warn(`[vscode-shim] WARN: ${message}`);
			return undefined;
		}
		const result = await getDialog().showMessageBox({
			type: "warning",
			message,
			buttons: items,
		});
		return items[result.response];
	},

	async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
		if (items.length === 0) {
			console.error(`[vscode-shim] ERROR: ${message}`);
			return undefined;
		}
		const result = await getDialog().showMessageBox({
			type: "error",
			message,
			buttons: items,
		});
		return items[result.response];
	},

	async showQuickPick(
		items: string[] | Promise<string[]>,
		_options?: { placeHolder?: string; canPickMany?: boolean },
	): Promise<string | undefined> {
		const resolved = await items;
		// For MVP, return first item. In Phase 3, render a proper picker in renderer
		console.warn("[vscode-shim] showQuickPick stub, returning first item");
		return resolved[0];
	},

	async showInputBox(
		_options?: { prompt?: string; value?: string; placeHolder?: string },
	): Promise<string | undefined> {
		console.warn("[vscode-shim] showInputBox stub");
		return undefined;
	},

	async showOpenDialog(
		_options?: unknown,
	): Promise<Uri[] | undefined> {
		console.warn("[vscode-shim] showOpenDialog stub");
		return undefined;
	},

	async showTextDocument(
		document: { uri: Uri } | Uri,
		_options?: unknown,
	): Promise<TextEditor | undefined> {
		const uri = "uri" in (document as object) ? (document as { uri: Uri }).uri : (document as Uri);
		console.log(`[vscode-shim] showTextDocument: ${uri.toString()}`);
		// Return a minimal editor stub
		return {
			document: {
				uri,
				fileName: uri.fsPath,
				getText() { return ""; },
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
			progress: { report(value: { message?: string; increment?: number }): void },
			token: { isCancellationRequested: boolean; onCancellationRequested: Event<void> },
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

	createOutputChannel(name: string, options?: { log: true } | string): OutputChannel {
		return createOutputChannel(name, options);
	},

	createTerminal(
		nameOrOptions?: string | { name?: string; cwd?: string; env?: Record<string, string | null>; shellPath?: string; shellArgs?: string[] },
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
		provider: unknown,
		options?: { webviewOptions?: { retainContextWhenHidden?: boolean }; supportsMultipleEditorsPerDocument?: boolean },
	): Disposable {
		console.log(`[vscode-shim] registerCustomEditorProvider: ${viewType}`);
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
