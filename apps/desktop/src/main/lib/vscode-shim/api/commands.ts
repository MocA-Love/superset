/**
 * VS Code commands API shim.
 */

import { shimLog, shimWarn } from "./debug-log";
import { Disposable } from "./event-emitter";

const UNHANDLED = Symbol("unhandled");

/**
 * Handle VS Code built-in commands that extensions expect to work.
 * Returns UNHANDLED if the command is not a known built-in.
 */
function handleBuiltinCommand(
	command: string,
	args: unknown[],
): unknown | typeof UNHANDLED {
	switch (command) {
		// Diff view (Claude Code uses this for file diffs)
		case "vscode.diff": {
			shimLog(
				`[vscode-shim] vscode.diff called with`,
				args[0],
				args[1],
				args[2],
			);
			// TODO: could open diff in Superset's file viewer
			return undefined;
		}

		// Open file
		case "vscode.open": {
			shimLog(`[vscode-shim] vscode.open called with`, args[0]);
			return undefined;
		}

		// Reveal file in OS file manager
		case "revealFileInOS":
		case "revealInExplorer": {
			try {
				const uri = args[0] as { fsPath?: string };
				if (uri?.fsPath) {
					const { shell } = require("electron");
					shell.showItemInFolder(uri.fsPath);
				}
			} catch {}
			return undefined;
		}

		// Focus editor
		case "workbench.action.focusFirstEditorGroup":
		case "workbench.action.lockEditorGroup":
			return undefined;

		// Reload window (Codex uses this)
		case "workbench.action.reloadWindow": {
			try {
				const { BrowserWindow } = require("electron");
				const win = BrowserWindow.getFocusedWindow();
				win?.reload();
			} catch {}
			return undefined;
		}

		// Open settings
		case "workbench.action.openSettings":
		case "workbench.action.openGlobalKeybindings":
		case "workbench.action.showCommands":
			// These don't have direct Superset equivalents
			return undefined;

		// Close active editor
		case "workbench.action.revertAndCloseActiveEditor":
		case "workbench.action.moveEditorToNewWindow":
			return undefined;

		// Speech/dictation (Claude Code)
		case "workbench.action.editorDictation.start":
		case "workbench.action.editorDictation.stop":
			return undefined;

		// Notebook (Claude Code)
		case "notebook.cell.execute":
			return undefined;

		default:
			return UNHANDLED;
	}
}

type CommandHandler = (...args: unknown[]) => unknown;

const registry = new Map<string, CommandHandler>();
const contextState = new Map<string, unknown>();

export function getContextValue(key: string): unknown {
	return contextState.get(key);
}

export const commands = {
	registerCommand(
		command: string,
		callback: CommandHandler,
		_thisArg?: unknown,
	): Disposable {
		registry.set(command, callback);
		return new Disposable(() => {
			registry.delete(command);
		});
	},

	async executeCommand<T = unknown>(
		command: string,
		...args: unknown[]
	): Promise<T> {
		if (command === "setContext") {
			const [key, value] = args;
			contextState.set(key as string, value);
			return undefined as T;
		}

		// Handle VS Code built-in commands
		const builtinResult = handleBuiltinCommand(command, args);
		if (builtinResult !== UNHANDLED) {
			return builtinResult as T;
		}

		const handler = registry.get(command);
		if (!handler) {
			shimWarn(`[vscode-shim] Command not found: ${command}`);
			return undefined as T;
		}
		return (await handler(...args)) as T;
	},

	getCommands(_filterInternal?: boolean): Promise<string[]> {
		return Promise.resolve([...registry.keys()]);
	},
};
