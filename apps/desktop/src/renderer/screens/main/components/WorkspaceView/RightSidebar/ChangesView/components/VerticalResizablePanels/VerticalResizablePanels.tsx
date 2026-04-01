import { cn } from "@superset/ui/utils";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
} from "react";

const HANDLE_SIZE = 6;

interface VerticalResizablePanelsProps {
	top: ReactNode;
	bottom: ReactNode;
	topSizePercentage: number;
	onTopSizePercentageChange: (percentage: number) => void;
	minTopHeight?: number;
	minBottomHeight?: number;
	defaultTopSizePercentage?: number;
	className?: string;
}

function clampTopSizePercentage(
	percentage: number,
	height: number,
	minTopHeight: number,
	minBottomHeight: number,
) {
	const usableHeight = Math.max(height - HANDLE_SIZE, 1);
	const minPercentage = (minTopHeight / usableHeight) * 100;
	const maxPercentage = 100 - (minBottomHeight / usableHeight) * 100;

	if (minPercentage > maxPercentage) {
		return Math.max(0, Math.min(100, percentage));
	}

	return Math.max(minPercentage, Math.min(maxPercentage, percentage));
}

export function VerticalResizablePanels({
	top,
	bottom,
	topSizePercentage,
	onTopSizePercentageChange,
	minTopHeight = 160,
	minBottomHeight = 140,
	defaultTopSizePercentage = 60,
	className,
}: VerticalResizablePanelsProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);

	const handleMouseDown = useCallback(
		(event: ReactMouseEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const container = containerRef.current;
			if (!container) return;

			const overlay = document.createElement("div");
			overlay.style.cssText =
				"position:fixed;inset:0;z-index:9999;cursor:row-resize;";
			document.body.appendChild(overlay);
			document.body.style.userSelect = "none";
			document.body.style.cursor = "row-resize";

			const onMouseMove = (moveEvent: MouseEvent) => {
				const rect = container.getBoundingClientRect();
				if (rect.height <= HANDLE_SIZE) return;

				const nextPercentage =
					((moveEvent.clientY - rect.top) / (rect.height - HANDLE_SIZE)) * 100;
				onTopSizePercentageChange(
					clampTopSizePercentage(
						nextPercentage,
						rect.height,
						minTopHeight,
						minBottomHeight,
					),
				);
			};

			const cleanup = () => {
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", cleanup);
				window.removeEventListener("blur", cleanup);
				document.body.style.userSelect = "";
				document.body.style.cursor = "";
				overlay.remove();
				cleanupRef.current = null;
			};

			cleanupRef.current = cleanup;
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", cleanup);
			window.addEventListener("blur", cleanup);
		},
		[minBottomHeight, minTopHeight, onTopSizePercentageChange],
	);

	const handleDoubleClick = useCallback(
		(event: ReactMouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			onTopSizePercentageChange(defaultTopSizePercentage);
		},
		[defaultTopSizePercentage, onTopSizePercentageChange],
	);

	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	return (
		<div
			ref={containerRef}
			className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
		>
			<div
				className="min-h-0 shrink-0 overflow-hidden"
				style={{ flexBasis: `${topSizePercentage}%` }}
			>
				{top}
			</div>
			<div
				role="separator"
				aria-orientation="horizontal"
				aria-valuenow={Math.round(topSizePercentage)}
				aria-valuemin={0}
				aria-valuemax={100}
				tabIndex={0}
				onMouseDown={handleMouseDown}
				onDoubleClick={handleDoubleClick}
				className={cn(
					"relative h-1.5 shrink-0 cursor-row-resize bg-background",
					"hover:bg-primary/10 active:bg-primary/20",
					"before:absolute before:left-1/2 before:top-1/2 before:h-px before:w-8 before:-translate-x-1/2 before:-translate-y-1/2 before:bg-border",
				)}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">{bottom}</div>
		</div>
	);
}
