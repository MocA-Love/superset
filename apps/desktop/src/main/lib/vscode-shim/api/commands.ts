/**
 * VS Code commands API shim.
 */

import { Disposable } from "./event-emitter.js";

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

		const handler = registry.get(command);
		if (!handler) {
			console.warn(`[vscode-shim] Command not found: ${command}`);
			return undefined as T;
		}
		return (await handler(...args)) as T;
	},

	getCommands(_filterInternal?: boolean): Promise<string[]> {
		return Promise.resolve([...registry.keys()]);
	},
};
