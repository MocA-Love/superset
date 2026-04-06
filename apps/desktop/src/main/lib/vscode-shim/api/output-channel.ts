/**
 * VS Code OutputChannel shim.
 */

import { Disposable } from "./event-emitter.js";

export class OutputChannel {
	readonly name: string;
	private _lines: string[] = [];
	private _disposed = false;

	constructor(name: string) {
		this.name = name;
	}

	append(value: string): void {
		if (this._disposed) return;
		const last = this._lines.length - 1;
		if (last >= 0) {
			this._lines[last] += value;
		} else {
			this._lines.push(value);
		}
	}

	appendLine(value: string): void {
		if (this._disposed) return;
		console.log(`[${this.name}] ${value}`);
		this._lines.push(value);
	}

	clear(): void {
		this._lines.length = 0;
	}

	show(_preserveFocus?: boolean): void {
		// In future, could switch to an output tab in the UI
	}

	hide(): void {
		// noop
	}

	replace(value: string): void {
		this._lines = [value];
	}

	dispose(): void {
		this._disposed = true;
		this._lines.length = 0;
	}
}

export class LogOutputChannel extends OutputChannel {
	trace(message: string, ..._args: unknown[]): void {
		this.appendLine(`[TRACE] ${message}`);
	}

	debug(message: string, ..._args: unknown[]): void {
		this.appendLine(`[DEBUG] ${message}`);
	}

	info(message: string, ..._args: unknown[]): void {
		this.appendLine(`[INFO] ${message}`);
	}

	warn(message: string, ..._args: unknown[]): void {
		this.appendLine(`[WARN] ${message}`);
	}

	error(error: string | Error, ..._args: unknown[]): void {
		const msg = error instanceof Error ? error.message : error;
		this.appendLine(`[ERROR] ${msg}`);
	}
}

const channels = new Map<string, OutputChannel>();

export function createOutputChannel(name: string, options?: { log: true } | string): OutputChannel {
	const existing = channels.get(name);
	if (existing) return existing;

	const channel =
		options && typeof options === "object" && options.log
			? new LogOutputChannel(name)
			: new OutputChannel(name);
	channels.set(name, channel);
	return channel;
}

export function getOutputChannelDisposable(): Disposable {
	return new Disposable(() => {
		for (const ch of channels.values()) ch.dispose();
		channels.clear();
	});
}
