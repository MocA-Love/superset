/**
 * Tests for the shared `centerPosition` utility used by:
 *  - CodeEditor.revealPosition (open-at-line for Search tab clicks, Problems,
 *    go-to-definition, etc.)
 *  - CodeEditor.scrollSearchMatchToCenter (Cmd+F find next/prev in raw editor)
 *  - CodeMirrorDiffViewer.scrollActiveSelectionToCenter (Cmd+F find next/prev
 *    in diff viewer; this is the path that was silently broken because it was
 *    setting scrollTop on the inner cm-scroller, which has overflow-y: visible
 *    !important inside MergeView and therefore does not scroll).
 *
 * The pure-math helpers (`computeCenterScrollTop`, `mapPosBetweenSides`,
 * `isConverged`) get full coverage with no DOM. The orchestration
 * (`centerPosition`) is exercised through a thin handcrafted EditorView
 * stub that records all writes to scrollContainer.scrollTop and the
 * effects sent through view.dispatch — this is exactly the surface area
 * we need to guard against future regressions.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { uncollapseUnchanged } from "@codemirror/merge";
import {
	centerPosition,
	computeCenterScrollTop,
	isConverged,
	mapPosBetweenSides,
	type ScrollMath,
} from "./centerPosition";

// =============================================================================
// Pure math
// =============================================================================

describe("computeCenterScrollTop", () => {
	const baseInput: ScrollMath = {
		documentScreenTop: -1000, // editor scrolled down 1000px below container top
		blockTop: 1500, // line is 1500px from top of doc
		blockHeight: 20,
		containerScreenTop: 0,
		containerVisibleHeight: 600,
		currentScrollTop: 1000,
	};

	it("places the block center at the visible viewport center", () => {
		// blockScreenCenter = -1000 + 1500 + 10 = 510
		// visibleAreaCenter = 0 + 300 = 300
		// delta = 510 - 300 = 210
		// newScrollTop = 1000 + 210 = 1210
		expect(computeCenterScrollTop(baseInput)).toBe(1210);
	});

	it("clamps the result to >= 0 (never scrolls past the document start)", () => {
		expect(
			computeCenterScrollTop({
				...baseInput,
				blockTop: 5,
				documentScreenTop: 0,
				currentScrollTop: 0,
			}),
		).toBe(0);
	});

	it("rounds the target so callers get an integer scrollTop", () => {
		// blockScreenCenter = -1000 + 1500 + 5 = 505
		// visibleAreaCenter = 0 + 300 = 300
		// delta = 205
		// new = 1000 + 205 = 1205
		const rounded = computeCenterScrollTop({
			...baseInput,
			blockHeight: 9.7,
		});
		expect(Number.isInteger(rounded)).toBe(true);
		expect(rounded).toBe(1205);
	});

	it("honors top extra margin (sticky header reserves screen-px at the top)", () => {
		// usableHeight = 600 - 100 - 0 = 500
		// visibleAreaCenter = 0 + 100 + 250 = 350
		// blockScreenCenter = 510 (same as base)
		// delta = 510 - 350 = 160
		// new = 1000 + 160 = 1160
		expect(
			computeCenterScrollTop({
				...baseInput,
				extraMargins: { top: 100 },
			}),
		).toBe(1160);
	});

	it("honors bottom extra margin", () => {
		// usableHeight = 600 - 0 - 100 = 500
		// visibleAreaCenter = 0 + 0 + 250 = 250
		// delta = 510 - 250 = 260
		// new = 1000 + 260 = 1260
		expect(
			computeCenterScrollTop({
				...baseInput,
				extraMargins: { bottom: 100 },
			}),
		).toBe(1260);
	});

	it("uniform formula: works regardless of which element is the scroller (raw vs MergeView)", () => {
		// REGRESSION GUARD for the MergeView bug. In MergeView the inner
		// .cm-scroller has overflow-y: visible !important, so its
		// clientHeight equals the full content height (huge) and writing
		// to its scrollTop is a no-op. centerPosition must instead read
		// the OUTER .cm-mergeView's clientHeight and write to its
		// scrollTop. The math below proves the formula gives the same
		// answer for both sides, as long as documentScreenTop and
		// containerScreenTop are read from the ACTUAL scrollable element.

		// Raw editor: scrollContainer === view.scrollDOM
		const raw = computeCenterScrollTop({
			documentScreenTop: -2000,
			blockTop: 2500,
			blockHeight: 20,
			containerScreenTop: 0,
			containerVisibleHeight: 800,
			currentScrollTop: 2000,
		});

		// MergeView: scrollContainer === mergeView.dom (outer). Same line
		// in the document, container also at the same screen position.
		// `documentScreenTop` is provided by `view.documentTop` which already
		// accounts for any padding between the outer container and the
		// editor's content area, so the formula yields the same delta.
		const merged = computeCenterScrollTop({
			documentScreenTop: -2000,
			blockTop: 2500,
			blockHeight: 20,
			containerScreenTop: 0,
			containerVisibleHeight: 800,
			currentScrollTop: 2000,
		});

		expect(raw).toBe(merged);
		// Also confirm a sane value: blockScreenCenter = -2000 + 2500 + 10 = 510;
		// visibleCenter = 400; delta = 110; new = 2110.
		expect(raw).toBe(2110);
	});

	it("handles container shorter than its margins (degenerate, must not throw or go negative)", () => {
		const result = computeCenterScrollTop({
			documentScreenTop: 0,
			blockTop: 0,
			blockHeight: 20,
			containerScreenTop: 0,
			containerVisibleHeight: 50,
			currentScrollTop: 0,
			extraMargins: { top: 80, bottom: 80 },
		});
		// usableHeight clamps to 0, visibleCenter becomes 0 + 80 + 0 = 80.
		// blockScreenCenter = 10. delta = -70. clamped to 0.
		expect(result).toBe(0);
	});
});

describe("isConverged", () => {
	it("treats values within tolerance as converged", () => {
		expect(isConverged(100, 100, 1)).toBe(true);
		expect(isConverged(100, 101, 1)).toBe(true);
		expect(isConverged(100, 99, 1)).toBe(true);
	});

	it("treats values outside tolerance as not converged", () => {
		expect(isConverged(100, 102, 1)).toBe(false);
		expect(isConverged(100, 98, 1)).toBe(false);
	});

	it("supports zero tolerance for exact matching", () => {
		expect(isConverged(100, 100, 0)).toBe(true);
		expect(isConverged(100, 101, 0)).toBe(false);
	});
});

describe("mapPosBetweenSides", () => {
	// Synthetic chunks: A side has [10..20] removed and B side has [10..15]
	// inserted at the same position. So unchanged before chunk[0] is
	// pos 0..9 on both sides; unchanged after chunk[0] is pos 20.. on A
	// and pos 15.. on B.
	const chunks = [
		// changes are not used by mapPosBetweenSides
		{
			changes: [],
			fromA: 10,
			toA: 20,
			fromB: 10,
			toB: 15,
			precise: true,
			get endA() {
				return 20;
			},
			get endB() {
				return 15;
			},
		},
	] as unknown as Parameters<typeof mapPosBetweenSides>[1];

	it("maps unchanged positions before any chunk identically", () => {
		expect(mapPosBetweenSides(5, chunks, "a")).toBe(5);
		expect(mapPosBetweenSides(5, chunks, "b")).toBe(5);
	});

	it("maps unchanged positions after a chunk to the sibling's offset", () => {
		// pos 25 on A (= 5 past the chunk on A) should map to pos 20 on B
		// (= 5 past the chunk on B, which started at 15).
		expect(mapPosBetweenSides(25, chunks, "a")).toBe(20);
		// And the symmetric direction.
		expect(mapPosBetweenSides(20, chunks, "b")).toBe(25);
	});

	it("returns the chunk start when called with the chunk start position", () => {
		expect(mapPosBetweenSides(10, chunks, "a")).toBe(10);
		expect(mapPosBetweenSides(10, chunks, "b")).toBe(10);
	});

	it("works with no chunks (identity mapping)", () => {
		expect(mapPosBetweenSides(42, [], "a")).toBe(42);
		expect(mapPosBetweenSides(42, [], "b")).toBe(42);
	});
});

// =============================================================================
// centerPosition (orchestration)
// =============================================================================

interface FakeBlock {
	top: number;
	height: number;
	from: number;
	to: number;
	type: number; // BlockType enum value
}

function makeFakeView(opts: {
	block: FakeBlock;
	/**
	 * The `view.documentTop` value to report when `scrollContainer.scrollTop`
	 * is at its initial value. Subsequent scrolls shift `documentTop` up by
	 * the scroll delta, mimicking the real `EditorView.documentTop` getter
	 * (which is `containerScreenTop - scrollTop + paddingTop`).
	 */
	initialDocumentTop: number;
	scrollDOM: HTMLElement;
	scrollContainer?: HTMLElement;
	state?: { selection?: { main?: { head?: number } } };
}) {
	const dispatched: Array<{ effects: unknown }> = [];
	const measureRequests: Array<{
		read: (v: unknown) => unknown;
		write?: (m: unknown, v: unknown) => void;
		key?: unknown;
	}> = [];
	const tracked = opts.scrollContainer ?? opts.scrollDOM;
	const initialScrollTop = tracked.scrollTop;
	const view = {
		get documentTop() {
			return opts.initialDocumentTop - (tracked.scrollTop - initialScrollTop);
		},
		scrollDOM: opts.scrollDOM,
		state: {
			selection: { main: { head: opts.state?.selection?.main?.head ?? 0 } },
		},
		dispatch: mock((spec: { effects?: unknown }) => {
			dispatched.push({ effects: spec.effects });
		}),
		lineBlockAt: mock((_pos: number) => opts.block),
		requestMeasure: mock(
			(req: {
				read: (v: unknown) => unknown;
				write?: (m: unknown, v: unknown) => void;
				key?: unknown;
			}) => {
				measureRequests.push(req);
			},
		),
	};
	return { view, dispatched, measureRequests };
}

function makeScrollContainer(opts: {
	clientHeight: number;
	rectTop: number;
	scrollTop?: number;
}) {
	let scrollTop = opts.scrollTop ?? 0;
	const writes: number[] = [];
	const rect = {
		top: opts.rectTop,
		bottom: opts.rectTop + opts.clientHeight,
		left: 0,
		right: 0,
		width: 0,
		height: opts.clientHeight,
		x: 0,
		y: opts.rectTop,
		toJSON() {
			return this;
		},
	};
	return {
		container: {
			get scrollTop() {
				return scrollTop;
			},
			set scrollTop(value: number) {
				scrollTop = value;
				writes.push(value);
			},
			clientHeight: opts.clientHeight,
			getBoundingClientRect: () => rect,
		} as unknown as HTMLElement,
		writes,
		setScrollTop: (v: number) => {
			scrollTop = v;
		},
	};
}

// Hold ResizeObserver instances for inspection.
const installedResizeObservers: Array<{
	callback: ResizeObserverCallback;
	observed: Element[];
	disconnect: ReturnType<typeof mock>;
	trigger: () => void;
}> = [];

let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalRAF: typeof globalThis.requestAnimationFrame | undefined;
let originalCancelRAF: typeof globalThis.cancelAnimationFrame | undefined;
const pendingRAFs: Array<() => void> = [];

beforeEach(() => {
	installedResizeObservers.length = 0;
	pendingRAFs.length = 0;

	originalResizeObserver = globalThis.ResizeObserver;
	originalRAF = globalThis.requestAnimationFrame;
	originalCancelRAF = globalThis.cancelAnimationFrame;

	class FakeResizeObserver {
		callback: ResizeObserverCallback;
		observed: Element[] = [];
		disconnect = mock(() => {});

		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
			installedResizeObservers.push({
				callback,
				observed: this.observed,
				disconnect: this.disconnect,
				trigger: () =>
					this.callback(
						[] as unknown as ResizeObserverEntry[],
						this as unknown as ResizeObserver,
					),
			});
		}

		observe(target: Element) {
			this.observed.push(target);
		}

		unobserve() {}
	}

	globalThis.ResizeObserver =
		FakeResizeObserver as unknown as typeof ResizeObserver;

	let rafId = 1;
	globalThis.requestAnimationFrame = ((cb: () => void) => {
		const id = rafId++;
		pendingRAFs.push(cb);
		return id;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((
		_id: number,
	) => {}) as typeof cancelAnimationFrame;
});

afterEach(() => {
	if (originalResizeObserver === undefined) {
		(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
			undefined;
	} else {
		globalThis.ResizeObserver = originalResizeObserver;
	}
	if (originalRAF !== undefined) {
		globalThis.requestAnimationFrame = originalRAF;
	}
	if (originalCancelRAF !== undefined) {
		globalThis.cancelAnimationFrame = originalCancelRAF;
	}
});

function flushAllRAFs(maxCycles = 10) {
	for (let i = 0; i < maxCycles && pendingRAFs.length > 0; i++) {
		const queued = pendingRAFs.splice(0, pendingRAFs.length);
		for (const cb of queued) cb();
	}
}

function flushMeasure(
	measureRequests: Array<{
		read: (v: unknown) => unknown;
		write?: (m: unknown, v: unknown) => void;
	}>,
	view: unknown,
) {
	const reqs = measureRequests.splice(0, measureRequests.length);
	for (const req of reqs) {
		const measured = req.read(view);
		req.write?.(measured, view);
	}
}

describe("centerPosition (orchestration)", () => {
	it("dispatches scrollIntoView so CM renders the target line region", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
		});
		const { view, dispatched } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: -1000,
			scrollDOM: container,
		});

		centerPosition({ view: view as never, scrollContainer: container }, 150);

		expect(dispatched.length).toBe(1);
		expect(dispatched[0]?.effects).toBeDefined();
	});

	it("when moveCursor: true, the dispatch also includes a selection update", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
		});
		const { view } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: -1000,
			scrollDOM: container,
		});

		centerPosition({ view: view as never, scrollContainer: container }, 150, {
			moveCursor: true,
		});

		expect(view.dispatch).toHaveBeenCalledTimes(1);
		const arg = (view.dispatch.mock.calls[0]?.[0] ?? {}) as {
			selection?: unknown;
		};
		expect(arg.selection).toBeDefined();
	});

	it("uses requestMeasure (not raw rAF) so it's synced with CM's measure cycle", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
		});
		const { view, measureRequests } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: -1000,
			scrollDOM: container,
		});

		centerPosition({ view: view as never, scrollContainer: container }, 150);

		expect(measureRequests.length).toBe(1);
		expect(view.requestMeasure).toHaveBeenCalledTimes(1);
	});

	it("writes scrollTop on the SCROLL CONTAINER passed by the caller (not view.scrollDOM)", () => {
		// REGRESSION GUARD for the MergeView fix. Caller passes the outer
		// .cm-mergeView (not view.scrollDOM). centerPosition must write
		// to that container.
		const innerScrollDOM = makeScrollContainer({
			clientHeight: 99999, // pretend overflow:visible — full content height
			rectTop: 0,
		});
		const outerContainer = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
			scrollTop: 1000,
		});
		const { view, measureRequests } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: -1000,
			scrollDOM: innerScrollDOM.container,
		});

		centerPosition(
			{ view: view as never, scrollContainer: outerContainer.container },
			150,
		);

		flushMeasure(measureRequests, view);

		expect(outerContainer.writes.length).toBeGreaterThanOrEqual(1);
		expect(innerScrollDOM.writes.length).toBe(0);
		// Targeted scrollTop = current(1000) + delta(blockScreenCenter 510 - visibleCenter 300) = 1210
		expect(outerContainer.writes[outerContainer.writes.length - 1]).toBe(1210);
	});

	it("does not write when the desired scrollTop equals the current (within tolerance)", () => {
		// Pre-positioned so the block is already centered:
		//   documentTop(at scrollTop=1210) = -1210
		//   blockScreenCenter = -1210 + 1500 + 10 = 300
		//   visibleAreaCenter = 0 + 300 = 300
		//   delta = 0 → no write needed.
		const writes: number[] = [];
		let _scrollTop = 1210;
		const container = {
			get scrollTop() {
				return _scrollTop;
			},
			set scrollTop(value: number) {
				_scrollTop = value;
				writes.push(value);
			},
			clientHeight: 600,
			getBoundingClientRect: () => ({
				top: 0,
				bottom: 600,
				left: 0,
				right: 0,
				width: 0,
				height: 600,
				x: 0,
				y: 0,
				toJSON() {
					return this;
				},
			}),
		} as unknown as HTMLElement;

		const { view, measureRequests } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: -1210,
			scrollDOM: container,
		});

		centerPosition({ view: view as never, scrollContainer: container }, 150);
		flushMeasure(measureRequests, view);
		expect(writes.length).toBe(0);
	});

	it("re-runs the measure pass until the target converges (heightMap refines after first scroll)", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
			scrollTop: 0,
		});

		// Block reports a different position on each successive lineBlockAt
		// call, simulating heightMap estimates getting refined as more
		// lines render.
		const blockSequence: FakeBlock[] = [
			{ top: 1000, height: 20, from: 100, to: 200, type: 0 },
			{ top: 1500, height: 20, from: 100, to: 200, type: 0 },
			{ top: 1500, height: 20, from: 100, to: 200, type: 0 },
		];

		const { view, measureRequests } = makeFakeView({
			block: blockSequence[0],
			initialDocumentTop: 0,
			scrollDOM: container,
		});
		let blockIndex = 0;
		view.lineBlockAt = mock(
			(_pos: number) =>
				blockSequence[Math.min(blockIndex, blockSequence.length - 1)],
		);

		centerPosition({ view: view as never, scrollContainer: container }, 150);

		// 1st measure: target = 0 + 1000 + 10 - 300 = 710
		flushMeasure(measureRequests, view);
		expect(container.scrollTop).toBe(710);
		expect(measureRequests.length).toBe(0);

		// rAF should have queued the next attempt because lastTarget was null.
		blockIndex = 1;
		flushAllRAFs(1);
		// 2nd measure: target = 0 + 1500 + 10 - 300 = 1210
		flushMeasure(measureRequests, view);
		expect(container.scrollTop).toBe(1210);

		// 3rd measure: target stays 1210 → converged → no more rAFs.
		blockIndex = 2;
		flushAllRAFs(1);
		flushMeasure(measureRequests, view);
		expect(container.scrollTop).toBe(1210);
		expect(measureRequests.length).toBe(0);
	});

	it("stops at maxAttempts even if targets keep oscillating", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
			scrollTop: 0,
		});
		let i = 0;
		const { view, measureRequests } = makeFakeView({
			block: { top: 1000, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: 0,
			scrollDOM: container,
		});
		view.lineBlockAt = mock((_pos: number) => ({
			top: 1000 + (i++ % 2) * 100,
			height: 20,
			from: 100,
			to: 200,
			type: 0,
		}));

		centerPosition({ view: view as never, scrollContainer: container }, 150, {
			maxAttempts: 3,
		});

		// Drain up to a generous number of cycles; should stop after maxAttempts measures.
		for (let cycle = 0; cycle < 10 && measureRequests.length > 0; cycle++) {
			flushMeasure(measureRequests, view);
			flushAllRAFs(1);
		}

		expect(
			(view.requestMeasure as ReturnType<typeof mock>).mock.calls.length,
		).toBe(3);
	});

	it("re-centers on container resize within the settle window", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
			scrollTop: 0,
		});
		const { view, measureRequests } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: 0,
			scrollDOM: container,
		});

		centerPosition({ view: view as never, scrollContainer: container }, 150);
		// Initial center.
		flushMeasure(measureRequests, view);
		const initial = container.scrollTop;

		// First ResizeObserver entry is the immediate observe() callback,
		// which centerPosition should ignore.
		const obs = installedResizeObservers[0];
		expect(obs).toBeDefined();
		obs?.trigger();
		// No new measure scheduled.
		expect(measureRequests.length).toBe(0);

		// A subsequent resize (e.g. pane width changes or theme reconfigure
		// mid-settle window) should re-trigger centering.
		obs?.trigger();
		expect(measureRequests.length).toBe(1);
		flushMeasure(measureRequests, view);
		expect(container.scrollTop).toBe(initial);
	});

	it("cancel() prevents further work and disconnects the ResizeObserver", () => {
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
		});
		const { view, measureRequests } = makeFakeView({
			block: { top: 1500, height: 20, from: 100, to: 200, type: 0 },
			initialDocumentTop: 0,
			scrollDOM: container,
		});

		const handle = centerPosition(
			{ view: view as never, scrollContainer: container },
			150,
		);
		// We don't run measure; we cancel before write fires.
		handle.cancel();
		expect(installedResizeObservers[0]?.disconnect).toHaveBeenCalled();

		// The pending requestMeasure write should bail out and not write scrollTop.
		flushMeasure(measureRequests, view);
		// Container scrollTop unchanged from initial.
		expect(container.scrollTop).toBe(0);
	});

	it("MergeView: when target pos sits inside a collapse block widget, dispatches uncollapseUnchanged on both sides", () => {
		// REGRESSION GUARD for the collapseUnchanged blind spot. block.type
		// === BlockType.WidgetRange (= 3) means the line is hidden behind
		// a block widget. centerPosition must dispatch uncollapseUnchanged
		// on both editors before centering.
		const { container } = makeScrollContainer({
			clientHeight: 600,
			rectTop: 0,
		});

		const blockA: FakeBlock = {
			top: 200,
			height: 27,
			from: 50,
			to: 100,
			type: 3, // BlockType.WidgetRange
		};

		const { view: viewA } = makeFakeView({
			block: blockA,
			initialDocumentTop: 0,
			scrollDOM: container,
		});
		// Sibling editor on side B.
		const dispatchedB: Array<{ effects: unknown }> = [];
		const viewB = {
			dispatch: (spec: { effects?: unknown }) => {
				dispatchedB.push({ effects: spec.effects });
			},
		};

		const fakeMergeView = {
			a: viewA,
			b: viewB,
			dom: container,
			chunks: [],
		};

		centerPosition(
			{
				view: viewA as never,
				scrollContainer: container,
				mergeView: fakeMergeView as never,
			},
			60,
		);

		// First dispatch on viewA must be the uncollapse effect for collapse start = block.from = 50.
		const firstA = (viewA.dispatch.mock.calls[0]?.[0] ?? {}) as {
			effects?: unknown;
		};
		const firstAEffect = firstA.effects;
		const isUncollapse = (effect: unknown): boolean => {
			if (!effect || typeof effect !== "object") return false;
			const e = effect as { is?: (t: unknown) => boolean };
			return typeof e.is === "function" && e.is(uncollapseUnchanged);
		};
		expect(isUncollapse(firstAEffect)).toBe(true);

		// Sibling B got an uncollapse dispatch as well.
		expect(dispatchedB.length).toBe(1);
		expect(isUncollapse(dispatchedB[0]?.effects)).toBe(true);
	});
});
