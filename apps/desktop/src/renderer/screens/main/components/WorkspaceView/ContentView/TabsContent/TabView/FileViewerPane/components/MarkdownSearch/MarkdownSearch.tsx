import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { HiChevronDown, HiChevronUp, HiMiniXMark } from "react-icons/hi2";

interface MarkdownSearchProps {
	isOpen: boolean;
	query: string;
	caseSensitive: boolean;
	matchCount: number;
	activeMatchIndex: number;
	onQueryChange: (query: string) => void;
	onCaseSensitiveChange: (caseSensitive: boolean) => void;
	onFindNext: () => void;
	onFindPrevious: () => void;
	onClose: () => void;
}

export function MarkdownSearch({
	isOpen,
	query,
	caseSensitive,
	matchCount,
	activeMatchIndex,
	onQueryChange,
	onCaseSensitiveChange,
	onFindNext,
	onFindPrevious,
	onClose,
}: MarkdownSearchProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const MIN_WIDTH = 320;
	const [width, setWidth] = useState(360);
	const dragStartX = useRef<number | null>(null);
	const dragStartWidth = useRef<number>(360);

	const handleResizeMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			dragStartX.current = event.clientX;
			dragStartWidth.current = width;

			const onMouseMove = (e: MouseEvent) => {
				if (dragStartX.current === null) return;
				const delta = dragStartX.current - e.clientX;
				const newWidth = Math.max(MIN_WIDTH, Math.min(800, dragStartWidth.current + delta));
				setWidth(newWidth);
			};

			const onMouseUp = () => {
				dragStartX.current = null;
				window.removeEventListener("mousemove", onMouseMove);
				window.removeEventListener("mouseup", onMouseUp);
			};

			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		},
		[width],
	);

	useEffect(() => {
		if (isOpen && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isOpen]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) {
				onFindPrevious();
			} else {
				onFindNext();
			}
		}
	};

	if (!isOpen) return null;

	const activeMatchLabel =
		matchCount === 0
			? "No results"
			: `${activeMatchIndex + 1} of ${matchCount}`;

	return (
		<div
			className="absolute top-1 right-1 z-10 rounded bg-popover/95 shadow-lg ring-1 ring-border/40 backdrop-blur"
			style={{ width: `min(${width}px, calc(100% - 0.5rem))` }}
		>
			{/* Left resize handle */}
			<div
				onMouseDown={handleResizeMouseDown}
				className="absolute left-0 top-0 h-full w-1 cursor-ew-resize rounded-l opacity-0 transition-opacity hover:opacity-100 hover:bg-blue-500/40"
				title="Drag to resize"
			/>
			<div className="px-2 py-1.5">
				<div className="flex items-center gap-1">
					{/* Input + option toggles */}
					<div className="flex flex-1 items-center gap-0.5 rounded border border-border bg-background/80 px-1.5 py-0.5 focus-within:ring-1 focus-within:ring-blue-500/50">
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => onQueryChange(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Find"
							className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
						/>
						<div className="flex items-center gap-0.5 pl-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() => onCaseSensitiveChange(!caseSensitive)}
										className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-medium leading-none transition-colors ${
											caseSensitive
												? "bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/40"
												: "text-muted-foreground hover:bg-accent hover:text-foreground"
										}`}
									>
										Aa
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom">Match Case (Alt+C)</TooltipContent>
							</Tooltip>
						</div>
					</div>

					{/* Match count */}
					{query ? (
						<span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
							{activeMatchLabel}
						</span>
					) : null}

					{/* Navigation buttons */}
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onFindPrevious}
								className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<HiChevronUp className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Previous (Shift+Enter)</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onFindNext}
								className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<HiChevronDown className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Next (Enter)</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onClose}
								className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								aria-label="Close search"
							>
								<HiMiniXMark className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Close (Esc)</TooltipContent>
					</Tooltip>
				</div>
			</div>
		</div>
	);
}
