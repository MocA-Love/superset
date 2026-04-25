import type { Chunk, MergeView } from "@codemirror/merge";
import { uncollapseUnchanged } from "@codemirror/merge";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { BlockType, EditorView as EditorViewClass } from "@codemirror/view";

/**
 * Pure scroll math.
 *
 * The block's vertical position is computed in screen coordinates as
 * `documentScreenTop + blockTop`, where `documentScreenTop` is
 * `view.documentTop` (the screen-coord top of the document content for
 * this view, may be negative when scrolled). The visible area's center is
 * derived from `containerScreenTop + clientHeight / 2`. The new scrollTop
 * is the current scrollTop plus the delta needed to align the two centers.
 *
 * This formulation works uniformly for the raw editor case
 * (scrollContainer === view.scrollDOM) and the MergeView case
 * (scrollContainer === mergeView.dom — the outer `.cm-mergeView`).
 */
export interface ScrollMath {
	/** Equal to `view.documentTop`. */
	documentScreenTop: number;
	/** Equal to `block.top`. Doc-relative. */
	blockTop: number;
	/** Equal to `block.height`. */
	blockHeight: number;
	/** Equal to `scrollContainer.getBoundingClientRect().top`. */
	containerScreenTop: number;
	/** Equal to `scrollContainer.clientHeight`. */
	containerVisibleHeight: number;
	/** Equal to `scrollContainer.scrollTop`. */
	currentScrollTop: number;
	/**
	 * Optional fixed-area screen-px margins for sticky overlays (header /
	 * footer). The visible area used for centering is shrunk by these.
	 */
	extraMargins?: { top?: number; bottom?: number };
}

export function computeCenterScrollTop(input: ScrollMath): number {
	const topMargin = input.extraMargins?.top ?? 0;
	const bottomMargin = input.extraMargins?.bottom ?? 0;
	const usableHeight = Math.max(
		0,
		input.containerVisibleHeight - topMargin - bottomMargin,
	);
	const blockScreenCenter =
		input.documentScreenTop + input.blockTop + input.blockHeight / 2;
	const visibleAreaScreenCenter =
		input.containerScreenTop + topMargin + usableHeight / 2;
	const delta = blockScreenCenter - visibleAreaScreenCenter;
	return Math.max(0, Math.round(input.currentScrollTop + delta));
}

export function isConverged(
	previous: number,
	next: number,
	tolerance: number,
): boolean {
	return Math.abs(next - previous) <= tolerance;
}

/**
 * Walk the merge view chunks to map an unchanged-region position from one
 * side to the other. Mirrors `mapPos` in @codemirror/merge (not exported).
 * Used to dispatch `uncollapseUnchanged` on the sibling editor.
 */
export function mapPosBetweenSides(
	pos: number,
	chunks: readonly Chunk[],
	fromSide: "a" | "b",
): number {
	const isA = fromSide === "a";
	let startOur = 0;
	let startOther = 0;
	for (let i = 0; ; i++) {
		const next = i < chunks.length ? chunks[i] : null;
		const nextOurStart = next ? (isA ? next.fromA : next.fromB) : null;
		if (next === null || (nextOurStart !== null && nextOurStart >= pos)) {
			return startOther + (pos - startOur);
		}
		if (isA) {
			startOur = next.toA;
			startOther = next.toB;
		} else {
			startOur = next.toB;
			startOther = next.toA;
		}
	}
}

interface CenterTarget {
	view: EditorView;
	/**
	 * The element that actually scrolls.
	 * - For raw single editor: `view.scrollDOM`
	 * - For MergeView: `mergeView.dom` (the outer `.cm-mergeView`)
	 *
	 * Inside MergeView the inner `.cm-scroller` has `overflow-y: visible
	 * !important`, so writing to `view.scrollDOM.scrollTop` is a no-op and
	 * `view.scrollDOM.clientHeight` returns the full content height.
	 */
	scrollContainer: HTMLElement;
	/**
	 * MergeView instance when `view` is one of `mv.a` / `mv.b`. Required to
	 * uncollapse a `collapseUnchanged` block that hides the search match.
	 */
	mergeView?: MergeView;
}

interface CenterOptions {
	maxAttempts?: number;
	tolerance?: number;
	settleWindowMs?: number;
	extraMargins?: { top?: number; bottom?: number };
	/**
	 * If true, also dispatch a selection update to `pos` on `view` so that
	 * the cursor moves to the centered position (used by `revealPosition`).
	 * Cmd+F search next/prev callers leave this false because `runFindNext`
	 * already updated the selection.
	 */
	moveCursor?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<CenterOptions, "extraMargins">> = {
	maxAttempts: 4,
	tolerance: 1,
	settleWindowMs: 400,
	moveCursor: false,
};

export interface CenterHandle {
	cancel: () => void;
}

/**
 * Center the given document position in the visible viewport, robustly:
 *
 * 1. If the position is inside a block widget that hides it (e.g. a
 *    `collapseUnchanged` block in a MergeView), uncollapse it first via
 *    the official `uncollapseUnchanged` state effect.
 * 2. Issue a `scrollIntoView({y: "nearest"})` so CM renders / measures the
 *    target line region.
 * 3. Run a measure pass via `view.requestMeasure` to compute the centered
 *    scrollTop using the freshly measured layout, and apply it.
 * 4. Run up to `maxAttempts` more measure passes if the computed target
 *    still differs from the previous (the heightMap may refine after the
 *    first scroll because lines around the target just got rendered).
 * 5. Watch the scroll container with a ResizeObserver for `settleWindowMs`
 *    so late layout shifts (pane resize, theme reconfigure, font load)
 *    re-center automatically instead of leaving the match off-target.
 */
export function centerPosition(
	target: CenterTarget,
	pos: number,
	options: CenterOptions = {},
): CenterHandle {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const { view, scrollContainer, mergeView } = target;

	let cancelled = false;
	let pendingFrame: number | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;

	const cancel = () => {
		cancelled = true;
		if (pendingFrame !== null) {
			cancelAnimationFrame(pendingFrame);
			pendingFrame = null;
		}
		if (resizeObserver) {
			resizeObserver.disconnect();
			resizeObserver = null;
		}
		if (settleTimer !== null) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
	};

	if (mergeView) {
		uncollapseIfHidden(view, pos, mergeView);
	}

	const initialEffects = [EditorViewClass.scrollIntoView(pos)];
	if (opts.moveCursor) {
		view.dispatch({
			selection: EditorSelection.cursor(pos),
			effects: initialEffects,
		});
	} else {
		view.dispatch({ effects: initialEffects });
	}

	let lastTarget: number | null = null;
	let attempts = 0;

	const measureAndApply = () => {
		if (cancelled) return;
		attempts += 1;
		view.requestMeasure({
			key: "centerPosition",
			read: (v) => {
				const block = v.lineBlockAt(pos);
				const containerRect = scrollContainer.getBoundingClientRect();
				const desired = computeCenterScrollTop({
					documentScreenTop: v.documentTop,
					blockTop: block.top,
					blockHeight: block.height,
					containerScreenTop: containerRect.top,
					containerVisibleHeight: scrollContainer.clientHeight,
					currentScrollTop: scrollContainer.scrollTop,
					extraMargins: opts.extraMargins,
				});
				return {
					desired,
					current: scrollContainer.scrollTop,
				};
			},
			write: ({ desired, current }) => {
				if (cancelled) return;
				if (Math.abs(desired - current) > opts.tolerance) {
					scrollContainer.scrollTop = desired;
				}
				const converged =
					lastTarget !== null &&
					isConverged(lastTarget, desired, opts.tolerance);
				lastTarget = desired;
				if (!converged && attempts < opts.maxAttempts) {
					pendingFrame = requestAnimationFrame(() => {
						pendingFrame = null;
						measureAndApply();
					});
				}
			},
		});
	};

	measureAndApply();

	if (typeof ResizeObserver !== "undefined" && opts.settleWindowMs > 0) {
		let initialFire = true;
		resizeObserver = new ResizeObserver(() => {
			if (cancelled) return;
			// ResizeObserver fires once on observe(). Skip that initial entry
			// — the first measureAndApply() above is already in flight.
			if (initialFire) {
				initialFire = false;
				return;
			}
			attempts = 0;
			lastTarget = null;
			measureAndApply();
		});
		resizeObserver.observe(scrollContainer);
		settleTimer = setTimeout(() => {
			if (resizeObserver) {
				resizeObserver.disconnect();
				resizeObserver = null;
			}
			settleTimer = null;
		}, opts.settleWindowMs);
	}

	return { cancel };
}

/**
 * Detect whether `pos` falls inside a block widget that visually hides
 * the line (typically a `collapseUnchanged` collapse). If so, dispatch
 * `uncollapseUnchanged` on both editors so the match becomes visible.
 *
 * Notes:
 * - We can't access the merge package's private `CollapsedRanges` field,
 *   so we detect via `view.lineBlockAt(pos).type === BlockType.WidgetRange`.
 *   `uncollapseUnchanged.of(start)` is a no-op when no matching decoration
 *   starts at `start`, so dispatching for non-collapse block widgets is
 *   safe.
 * - For the sibling editor we map the position via `mergeView.chunks`
 *   because collapseUnchanged ranges live in unchanged regions and can
 *   start at different positions on each side.
 */
function uncollapseIfHidden(
	view: EditorView,
	pos: number,
	mergeView: MergeView,
): void {
	const block = view.lineBlockAt(pos);
	if (block.type !== BlockType.WidgetRange) return;

	const collapseStart = block.from;
	const onSideA = view === mergeView.a;
	const sibling = onSideA ? mergeView.b : mergeView.a;

	view.dispatch({ effects: uncollapseUnchanged.of(collapseStart) });
	const siblingPos = mapPosBetweenSides(
		collapseStart,
		mergeView.chunks,
		onSideA ? "a" : "b",
	);
	sibling.dispatch({ effects: uncollapseUnchanged.of(siblingPos) });
}
