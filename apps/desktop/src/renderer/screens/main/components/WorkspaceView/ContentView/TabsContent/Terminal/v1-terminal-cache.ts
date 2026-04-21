import type { Unsubscribable } from "@trpc/server/observable";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import { markTerminalSessionReady } from "renderer/lib/terminal/session-readiness";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { DEBUG_TERMINAL } from "./config";
import { logTerminalWrite, terminalRendererDebug } from "./debug";
import { type CreateTerminalOptions, createTerminalInWrapper } from "./helpers";
import type { TerminalStreamEvent } from "./types";

/**
 * Cached xterm instance that survives React mount/unmount cycles.
 * Borrows the wrapper-div pattern from v2's terminal-runtime.ts:
 * xterm is opened into a persistent wrapper <div> that can be
 * moved between DOM containers without disposing the terminal.
 *
 * Also owns the tRPC stream subscription so data continues flowing
 * to xterm even while the React component is unmounted (tab hidden).
 */
export interface CachedTerminal {
	xterm: XTerm;
	fitAddon: FitAddon;
	searchAddon: SearchAddon;
	wrapper: HTMLDivElement;
	/** Disposes renderer RAF, query suppression, GPU renderer, etc. */
	cleanupCreation: () => void;
	/** Last known dimensions — used to skip no-op resize events. */
	lastCols: number;
	lastRows: number;

	// --- Stream management ---

	/** The live tRPC subscription. Null until startStream() is called. */
	subscription: Unsubscribable | null;
	/** True once the first createOrAttach succeeds and the stream gate opens. */
	streamReady: boolean;
	/** Events queued before streamReady (first mount only). */
	pendingStreamEvents: TerminalStreamEvent[];
	/** Non-data events queued while no component is mounted. */
	pendingLifecycleEvents: TerminalStreamEvent[];
	/**
	 * Handler provided by the mounted Terminal component.
	 * When set, ALL events are forwarded here so the component can
	 * update React state (exit status, connection error, modes, cwd, etc.).
	 * When null (component unmounted), data events write directly to xterm
	 * and non-data events are queued.
	 */
	eventHandler: ((event: TerminalStreamEvent) => void) | null;
	/**
	 * Error handler for tRPC subscription-level errors (distinct from
	 * terminal stream error events).
	 */
	subscriptionErrorHandler: ((error: unknown) => void) | null;
	/** ResizeObserver for the attached container. Managed by attach/detach. */
	resizeObserver: ResizeObserver | null;
	/** rAF-batched write buffer: data accumulates here until the next frame. */
	rafWriteBuffer: string;
	rafWriteId: ReturnType<typeof requestAnimationFrame> | null;
}

const cache = new Map<string, CachedTerminal>();

export function has(paneId: string): boolean {
	return cache.has(paneId);
}

export function get(paneId: string): CachedTerminal | undefined {
	return cache.get(paneId);
}

export function getOrCreate(
	paneId: string,
	options: CreateTerminalOptions,
): CachedTerminal {
	const existing = cache.get(paneId);
	if (existing) return existing;

	if (DEBUG_TERMINAL) {
		console.log(`[v1-terminal-cache] Creating new terminal: ${paneId}`);
	}

	const { xterm, fitAddon, searchAddon, wrapper, cleanup } =
		createTerminalInWrapper(options);

	const entry: CachedTerminal = {
		xterm,
		fitAddon,
		searchAddon,
		wrapper,
		cleanupCreation: cleanup,
		subscription: null,
		streamReady: false,
		pendingStreamEvents: [],
		pendingLifecycleEvents: [],
		eventHandler: null,
		subscriptionErrorHandler: null,
		resizeObserver: null,
		lastCols: xterm.cols,
		lastRows: xterm.rows,
		rafWriteBuffer: "",
		rafWriteId: null,
	};

	cache.set(paneId, entry);
	return entry;
}

// --- DOM attach / detach ---

export function attachToContainer(
	paneId: string,
	container: HTMLDivElement,
	onResize?: () => void,
): void {
	const entry = cache.get(paneId);
	if (!entry) return;

	container.appendChild(entry.wrapper);
	terminalRendererDebug.info(
		"cache-attach-to-container",
		{
			paneId,
			hasSubscription: entry.subscription !== null,
			streamReady: entry.streamReady,
		},
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "cache-attach-to-container"],
		},
	);

	if (container.clientWidth > 0 && container.clientHeight > 0) {
		entry.fitAddon.fit();
		entry.lastCols = entry.xterm.cols;
		entry.lastRows = entry.xterm.rows;
	}

	// Renderer may have skipped frames while the wrapper was detached.
	entry.xterm.refresh(0, Math.max(0, entry.xterm.rows - 1));

	// Manage ResizeObserver lifecycle in the cache, not in React.
	entry.resizeObserver?.disconnect();
	const observer = new ResizeObserver(() => {
		if (container.clientWidth === 0 || container.clientHeight === 0) return;
		const prevCols = entry.lastCols;
		const prevRows = entry.lastRows;
		entry.fitAddon.fit();
		entry.lastCols = entry.xterm.cols;
		entry.lastRows = entry.xterm.rows;
		if (entry.lastCols !== prevCols || entry.lastRows !== prevRows) {
			onResize?.();
		}
	});
	observer.observe(container);
	entry.resizeObserver = observer;
}

export function detachFromContainer(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry) return;

	if (DEBUG_TERMINAL) {
		console.log(`[v1-terminal-cache] detachFromContainer: ${paneId}`);
	}
	terminalRendererDebug.info(
		"cache-detach-from-container",
		{
			paneId,
			hasSubscription: entry.subscription !== null,
			streamReady: entry.streamReady,
		},
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "cache-detach-from-container"],
		},
	);
	entry.resizeObserver?.disconnect();
	entry.resizeObserver = null;
	entry.wrapper.remove();
}

// --- Appearance ---

/**
 * Update font settings on a cached terminal. If font changed and the
 * terminal is visible, re-fit and return true so the caller can send
 * a backend resize if needed.
 */
export function updateAppearance(
	paneId: string,
	fontFamily: string,
	fontSize: number,
): { cols: number; rows: number; changed: boolean } | null {
	const entry = cache.get(paneId);
	if (!entry) return null;

	const { xterm, fitAddon } = entry;
	const fontChanged =
		xterm.options.fontFamily !== fontFamily ||
		xterm.options.fontSize !== fontSize;
	if (!fontChanged) return null;

	xterm.options.fontFamily = fontFamily;
	xterm.options.fontSize = fontSize;

	const prevCols = entry.lastCols;
	const prevRows = entry.lastRows;
	fitAddon.fit();
	entry.lastCols = xterm.cols;
	entry.lastRows = xterm.rows;

	return {
		cols: xterm.cols,
		rows: xterm.rows,
		changed: xterm.cols !== prevCols || xterm.rows !== prevRows,
	};
}

// --- rAF write buffer ---

/**
 * Batch xterm.write calls into one per animation frame to reduce the number
 * of parser/render cycles. Callers accumulate data here; the actual write
 * fires in the next rAF, coalescing all chunks that arrived within ~16 ms.
 */
export function scheduleWrite(paneId: string, data: string): void {
	const entry = cache.get(paneId);
	if (!entry) return;
	entry.rafWriteBuffer += data;
	if (entry.rafWriteId === null) {
		entry.rafWriteId = requestAnimationFrame(() => {
			const e = cache.get(paneId);
			if (!e) return;
			if (e.rafWriteBuffer) {
				e.xterm.write(e.rafWriteBuffer);
				e.rafWriteBuffer = "";
			}
			e.rafWriteId = null;
		});
	}
}

/**
 * Immediately flush any buffered data to xterm, cancelling the pending rAF.
 * Must be called before processing exit/error/disconnect events so that
 * trailing output is rendered before the exit banner or pane disposal.
 */
export function flushWrite(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry) return;
	if (entry.rafWriteId !== null) {
		cancelAnimationFrame(entry.rafWriteId);
		entry.rafWriteId = null;
	}
	if (entry.rafWriteBuffer) {
		entry.xterm.write(entry.rafWriteBuffer);
		entry.rafWriteBuffer = "";
	}
}

// --- Stream subscription ---

function routeEvent(
	paneId: string,
	entry: CachedTerminal,
	event: TerminalStreamEvent,
): void {
	// Before stream is ready: queue everything (first-mount gating).
	if (!entry.streamReady) {
		entry.pendingStreamEvents.push(event);
		return;
	}

	// Component mounted — forward all events there.
	if (entry.eventHandler) {
		entry.eventHandler(event);
		return;
	}

	// Component unmounted — write data directly to xterm, queue the rest.
	// ここは hidden terminal 継続処理の観測点で、主問題ではなく副次仮説。
	// 「表示中なのに描画されない」問題とは別軸で、
	// hidden 中も xterm.write が走り続けていないかを見る。
	if (event.type === "data") {
		terminalRendererDebug.increment("hidden-data-events", 1, {
			data: { paneId, bytes: event.data.length },
		});
		terminalRendererDebug.observe("hidden-data-bytes", event.data.length, {
			data: { paneId },
		});
		logTerminalWrite("hidden-stream-data", event.data.length, { paneId });
		scheduleWrite(paneId, event.data);
	} else {
		flushWrite(paneId);
		entry.pendingLifecycleEvents.push(event);
	}
}

/**
 * Start the tRPC stream subscription for this terminal.
 * Called once on first mount after createOrAttach succeeds.
 * The subscription stays alive across component mount/unmount cycles
 * and is only stopped on dispose().
 */
export function startStream(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry || entry.subscription) return;

	if (DEBUG_TERMINAL) {
		console.log(`[v1-terminal-cache] Starting stream: ${paneId}`);
	}
	terminalRendererDebug.info(
		"cache-start-stream",
		{ paneId },
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "cache-start-stream"],
		},
	);

	entry.subscription = electronTrpcClient.terminal.stream.subscribe(paneId, {
		onData: (event: TerminalStreamEvent) => {
			routeEvent(paneId, entry, event);
		},
		onError: (error: unknown) => {
			// Subscription is dead after onError — null it and reset streamReady
			// so the next remount goes through the full create/attach path.
			entry.subscription = null;
			entry.streamReady = false;
			terminalRendererDebug.error(
				"cache-stream-error",
				{
					paneId,
					errorMessage: error instanceof Error ? error.message : String(error),
				},
				{
					captureMessage: true,
					fingerprint: ["terminal.renderer", "cache-stream-error"],
				},
			);

			if (entry.subscriptionErrorHandler) {
				entry.subscriptionErrorHandler(error);
			} else if (DEBUG_TERMINAL) {
				console.error(
					`[v1-terminal-cache] Stream error (no handler): ${paneId}`,
					error,
				);
			}
		},
	});
}

/**
 * Mark the stream as ready and flush any events queued during the
 * first-mount gating period (before createOrAttach completed).
 */
export function setStreamReady(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry || entry.streamReady) return;

	if (DEBUG_TERMINAL) {
		console.log(
			`[v1-terminal-cache] Stream ready: ${paneId}, flushing ${entry.pendingStreamEvents.length} queued events`,
		);
	}
	terminalRendererDebug.info(
		"cache-stream-ready",
		{ paneId, pendingStreamEvents: entry.pendingStreamEvents.length },
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "cache-stream-ready"],
		},
	);

	entry.streamReady = true;
	const pending = entry.pendingStreamEvents.splice(0);
	for (const event of pending) {
		routeEvent(paneId, entry, event);
	}
}

/**
 * Mark a pane as session-ready: start the tRPC stream, flip the cache's
 * `streamReady` flag, and resolve any {@link waitForTerminalSessionReady}
 * waiters in one step.
 *
 * FORK NOTE: centralizes the three-call sequence so the cold-restore and
 * normal attach paths can't drift — see useTerminalLifecycle.ts and
 * useTerminalColdRestore.ts.
 */
export function markSessionReady(paneId: string): void {
	startStream(paneId);
	setStreamReady(paneId);
	markTerminalSessionReady(paneId);
}

/**
 * Register event handlers from the mounted Terminal component.
 * Returns any lifecycle events (exit, error, disconnect) that were
 * queued while the component was unmounted.
 */
export function registerHandlers(
	paneId: string,
	handlers: {
		onEvent: (event: TerminalStreamEvent) => void;
		onError: (error: unknown) => void;
	},
): TerminalStreamEvent[] {
	const entry = cache.get(paneId);
	if (!entry) return [];

	entry.eventHandler = handlers.onEvent;
	entry.subscriptionErrorHandler = handlers.onError;

	// Drain and return queued lifecycle events
	return entry.pendingLifecycleEvents.splice(0);
}

/**
 * Unregister the component's event handlers (component unmounting).
 * The subscription stays alive; data events write directly to xterm.
 */
export function unregisterHandlers(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry) return;

	entry.eventHandler = null;
	entry.subscriptionErrorHandler = null;
}

// --- Disposal ---

export function dispose(paneId: string): void {
	const entry = cache.get(paneId);
	if (!entry) return;

	if (DEBUG_TERMINAL) {
		console.log(`[v1-terminal-cache] Disposing: ${paneId}`);
	}
	terminalRendererDebug.info(
		"cache-dispose",
		{ paneId },
		{
			captureMessage: true,
			fingerprint: ["terminal.renderer", "cache-dispose"],
		},
	);

	entry.resizeObserver?.disconnect();
	entry.subscription?.unsubscribe();
	if (entry.rafWriteId !== null) {
		cancelAnimationFrame(entry.rafWriteId);
	}
	entry.cleanupCreation();
	entry.xterm.dispose();
	cache.delete(paneId);
}

// Preserve cache across Vite HMR in dev so active terminals aren't orphaned.
const hot = import.meta.hot;
if (hot) {
	const existing = hot.data.v1TerminalCache as
		| Map<string, CachedTerminal>
		| undefined;
	if (existing) {
		for (const [k, v] of existing) {
			v.rafWriteBuffer ??= "";
			v.rafWriteId ??= null;
			cache.set(k, v);
		}
	}
	hot.data.v1TerminalCache = cache;
}
