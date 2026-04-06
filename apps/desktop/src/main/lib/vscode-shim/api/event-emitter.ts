/**
 * VS Code EventEmitter and Disposable shim.
 */

export type Event<T> = (
	listener: (e: T) => unknown,
	thisArgs?: unknown,
	disposables?: Disposable[],
) => Disposable;

export class Disposable {
	private _callOnDispose: (() => void) | undefined;

	constructor(callOnDispose: () => void) {
		this._callOnDispose = callOnDispose;
	}

	static from(...disposables: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => {
			for (const d of disposables) {
				d.dispose();
			}
		});
	}

	dispose(): void {
		this._callOnDispose?.();
		this._callOnDispose = undefined;
	}
}

export class EventEmitter<T> {
	private _listeners: Array<{ fn: (e: T) => unknown; thisArgs?: unknown }> = [];
	private _disposed = false;

	readonly event: Event<T> = (
		listener: (e: T) => unknown,
		thisArgs?: unknown,
		disposables?: Disposable[],
	): Disposable => {
		const entry = { fn: listener, thisArgs };
		this._listeners.push(entry);
		const disposable = new Disposable(() => {
			const idx = this._listeners.indexOf(entry);
			if (idx >= 0) this._listeners.splice(idx, 1);
		});
		if (disposables) disposables.push(disposable);
		return disposable;
	};

	fire(data: T): void {
		if (this._disposed) return;
		for (const { fn, thisArgs } of [...this._listeners]) {
			fn.call(thisArgs, data);
		}
	}

	dispose(): void {
		this._disposed = true;
		this._listeners.length = 0;
	}
}

export class CancellationTokenSource {
	private _emitter = new EventEmitter<void>();
	private _isCancelled = false;

	readonly token: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: this._emitter.event,
	};

	cancel(): void {
		if (!this._isCancelled) {
			this._isCancelled = true;
			(this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
			this._emitter.fire(undefined as void);
		}
	}

	dispose(): void {
		this._emitter.dispose();
	}
}

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: Event<void>;
}
