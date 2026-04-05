import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useRef } from "react";

interface ResizablePanelProps {
	/** The content to render inside the panel */
	children: React.ReactNode;
	/** Current width of the panel */
	width: number;
	/** Callback when width changes */
	onWidthChange: (width: number) => void;
	/** Whether the panel is currently being resized */
	isResizing: boolean;
	/** Callback when resizing state changes */
	onResizingChange: (isResizing: boolean) => void;
	/** Minimum allowed width (used for clamping and aria) */
	minWidth: number;
	/** Maximum allowed width (used for clamping and aria) */
	maxWidth: number;
	/** Which side the resize handle should be on */
	handleSide: "left" | "right";
	/** Additional className for the container */
	className?: string;
	/**
	 * If true, the component will clamp width between minWidth and maxWidth.
	 * If false, raw width values are passed to onWidthChange (useful when the
	 * consumer's setWidth handles clamping/snapping logic).
	 * @default true
	 */
	clampWidth?: boolean;
	/** Callback when the resize handle is double-clicked */
	onDoubleClickHandle?: () => void;
}

export function ResizablePanel({
	children,
	width,
	onWidthChange,
	isResizing,
	onResizingChange,
	minWidth,
	maxWidth,
	handleSide,
	className,
	clampWidth = true,
	onDoubleClickHandle,
}: ResizablePanelProps) {
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const isResizingRef = useRef(false);
	const pendingWidthRef = useRef<number | null>(null);
	const rafIdRef = useRef<number | null>(null);
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const widthRef = useRef(width);
	widthRef.current = width;
	const onWidthChangeRef = useRef(onWidthChange);
	onWidthChangeRef.current = onWidthChange;
	const onResizingChangeRef = useRef(onResizingChange);
	onResizingChangeRef.current = onResizingChange;
	const handleSideRef = useRef(handleSide);
	handleSideRef.current = handleSide;
	const clampWidthRef = useRef(clampWidth);
	clampWidthRef.current = clampWidth;
	const minWidthRef = useRef(minWidth);
	minWidthRef.current = minWidth;
	const maxWidthRef = useRef(maxWidth);
	maxWidthRef.current = maxWidth;

	const computeWidth = useCallback((clientX: number) => {
		const delta = clientX - startXRef.current;
		const adjustedDelta = handleSideRef.current === "left" ? -delta : delta;
		const newWidth = startWidthRef.current + adjustedDelta;
		return clampWidthRef.current
			? Math.max(minWidthRef.current, Math.min(maxWidthRef.current, newWidth))
			: newWidth;
	}, []);

	const cleanup = useCallback(() => {
		isResizingRef.current = false;
		pendingWidthRef.current = null;
		abortRef.current?.abort();
		abortRef.current = null;
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		if (rafIdRef.current !== null) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		}
		if (overlayRef.current) {
			overlayRef.current.remove();
			overlayRef.current = null;
		}
	}, []);

	useEffect(() => {
		return () => {
			if (isResizingRef.current) {
				cleanup();
				onResizingChangeRef.current(false);
			}
		};
	}, [cleanup]);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			if (isResizingRef.current) return;
			e.preventDefault();

			startXRef.current = e.clientX;
			startWidthRef.current = widthRef.current;
			isResizingRef.current = true;

			const ac = new AbortController();
			abortRef.current = ac;

			document.addEventListener(
				"pointermove",
				(ev: PointerEvent) => {
					if (!isResizingRef.current) return;

					pendingWidthRef.current = computeWidth(ev.clientX);

					if (rafIdRef.current !== null) return;
					rafIdRef.current = requestAnimationFrame(() => {
						rafIdRef.current = null;
						const w = pendingWidthRef.current;
						pendingWidthRef.current = null;
						if (w !== null) onWidthChangeRef.current(w);
					});
				},
				{ signal: ac.signal },
			);

			const handlePointerEnd = (ev: PointerEvent) => {
				if (!isResizingRef.current) return;

				if (rafIdRef.current !== null) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = null;
				}

				onWidthChangeRef.current(computeWidth(ev.clientX));
				cleanup();
				onResizingChangeRef.current(false);
			};

			document.addEventListener("pointerup", handlePointerEnd, {
				signal: ac.signal,
			});
			document.addEventListener("pointercancel", handlePointerEnd, {
				signal: ac.signal,
			});

			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";

			const overlay = document.createElement("div");
			overlay.style.cssText =
				"position:fixed;inset:0;z-index:9999;cursor:col-resize;";
			document.body.appendChild(overlay);
			overlayRef.current = overlay;

			onResizingChangeRef.current(true);
		},
		[computeWidth, cleanup],
	);

	return (
		<div
			className={cn(
				"relative h-full shrink-0 overflow-hidden border-border",
				handleSide === "right" ? "border-r" : "border-l",
				className,
			)}
			style={{ width }}
		>
			{children}
			{/* biome-ignore lint/a11y/useSemanticElements: <hr> is not appropriate for interactive resize handles */}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-valuenow={width}
				aria-valuemin={minWidth}
				aria-valuemax={maxWidth}
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onDoubleClick={onDoubleClickHandle}
				className={cn(
					"absolute top-0 w-5 h-full cursor-col-resize z-10",
					"after:absolute after:top-0 after:w-1 after:h-full after:transition-colors",
					"hover:after:bg-border focus:outline-none focus:after:bg-border",
					isResizing && "after:bg-border",
					handleSide === "left"
						? "-left-2 after:right-2"
						: "-right-2 after:left-2",
				)}
			/>
		</div>
	);
}
