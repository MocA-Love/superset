/**
 * VS Code Terminal API shim backed by DaemonTerminalManager.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "./event-emitter.js";

interface TerminalOptions {
	name?: string;
	cwd?: string;
	env?: Record<string, string | null>;
	shellPath?: string;
	shellArgs?: string[];
}

interface ShimTerminal {
	readonly name: string;
	readonly processId: Promise<number | undefined>;
	readonly exitStatus: { code: number | undefined } | undefined;
	readonly shellIntegration?: ShellIntegration;
	sendText(text: string, addNewLine?: boolean): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
	dispose(): void;
}

interface ShellIntegration {
	executeCommand(command: string): {
		execution: { commandLine: string };
		read(): AsyncIterable<string>;
	};
}

const _onDidOpenTerminal = new EventEmitter<ShimTerminal>();
const _onDidCloseTerminal = new EventEmitter<ShimTerminal>();
const _onDidChangeActiveTerminal = new EventEmitter<ShimTerminal | undefined>();
const _onDidEndTerminalShellExecution = new EventEmitter<unknown>();
const _onDidChangeTerminalShellIntegration = new EventEmitter<unknown>();

export const terminalEvents = {
	onDidOpenTerminal: _onDidOpenTerminal.event,
	onDidCloseTerminal: _onDidCloseTerminal.event,
	onDidChangeActiveTerminal: _onDidChangeActiveTerminal.event,
	onDidEndTerminalShellExecution: _onDidEndTerminalShellExecution.event,
	onDidChangeTerminalShellIntegration:
		_onDidChangeTerminalShellIntegration.event,
};

const activeTerminals: ShimTerminal[] = [];

function getTerminalManager() {
	try {
		const { getDaemonTerminalManager } = require("main/lib/terminal");
		return getDaemonTerminalManager();
	} catch {
		return null;
	}
}

export function createTerminal(
	nameOrOptions?: string | TerminalOptions,
): ShimTerminal {
	const opts: TerminalOptions =
		typeof nameOrOptions === "string"
			? { name: nameOrOptions }
			: (nameOrOptions ?? {});

	const name = opts.name ?? "Extension Terminal";
	const paneId = `vscode-ext-terminal-${randomUUID()}`;
	let exitStatus: { code: number | undefined } | undefined;
	let pid: number | undefined;

	const manager = getTerminalManager();

	// Create session asynchronously
	const processIdPromise = (async () => {
		if (!manager) return undefined;
		try {
			const _result = await manager.createOrAttach({
				paneId,
				tabId: `vscode-ext-tab-${paneId}`,
				workspaceId: "vscode-extension-host",
				cwd: opts.cwd,
				cols: 120,
				rows: 30,
			});
			// Listen for exit
			manager.on(`exit:${paneId}`, (exitCode: number) => {
				exitStatus = { code: exitCode };
				_onDidCloseTerminal.fire(terminal);
				const idx = activeTerminals.indexOf(terminal);
				if (idx >= 0) activeTerminals.splice(idx, 1);
				_onDidEndTerminalShellExecution.fire({
					terminal,
					exitCode,
					execution: { commandLine: { value: "" } },
				});
			});
			return pid;
		} catch (err) {
			console.error(`[vscode-shim] Failed to create terminal "${name}":`, err);
			return undefined;
		}
	})();

	const terminal: ShimTerminal = {
		name,
		processId: processIdPromise,
		get exitStatus() {
			return exitStatus;
		},
		get shellIntegration(): ShellIntegration | undefined {
			if (!manager) return undefined;
			return {
				executeCommand(command: string) {
					manager.write({ paneId, data: `${command}\n` });
					return {
						execution: { commandLine: command },
						async *read() {
							// Collect output from the terminal
							const chunks: string[] = [];
							const handler = (data: string) => {
								chunks.push(data);
							};
							manager.on(`data:${paneId}`, handler);
							// Wait briefly for output
							await new Promise((r) => setTimeout(r, 500));
							manager.off(`data:${paneId}`, handler);
							yield chunks.join("");
						},
					};
				},
			};
		},
		sendText(text: string, addNewLine = true) {
			if (!manager) {
				console.log(`[vscode-shim] Terminal "${name}" sendText: ${text}`);
				return;
			}
			manager.write({
				paneId,
				data: addNewLine ? `${text}\n` : text,
			});
		},
		show(_preserveFocus?: boolean) {
			// Could focus the terminal in the UI
		},
		hide() {
			// noop
		},
		dispose() {
			if (manager) {
				manager.kill(paneId).catch(() => {});
			}
			const idx = activeTerminals.indexOf(terminal);
			if (idx >= 0) activeTerminals.splice(idx, 1);
			_onDidCloseTerminal.fire(terminal);
		},
	};

	activeTerminals.push(terminal);
	_onDidOpenTerminal.fire(terminal);
	_onDidChangeActiveTerminal.fire(terminal);

	return terminal;
}

export function getTerminals(): ShimTerminal[] {
	return [...activeTerminals];
}

export function getActiveTerminal(): ShimTerminal | undefined {
	return activeTerminals[activeTerminals.length - 1];
}
