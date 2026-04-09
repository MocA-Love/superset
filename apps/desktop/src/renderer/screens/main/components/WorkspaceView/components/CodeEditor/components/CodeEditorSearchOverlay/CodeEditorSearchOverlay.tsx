import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { HiChevronDown, HiChevronUp, HiMiniXMark } from "react-icons/hi2";

interface CodeEditorSearchOverlayProps {
	isOpen: boolean;
	query: string;
	replaceText: string;
	caseSensitive: boolean;
	regexp: boolean;
	wholeWord: boolean;
	matchCount: number;
	activeMatchIndex: number;
	readOnly: boolean;
	onQueryChange: (query: string) => void;
	onReplaceTextChange: (replaceText: string) => void;
	onCaseSensitiveChange: (caseSensitive: boolean) => void;
	onRegexpChange: (regexp: boolean) => void;
	onWholeWordChange: (wholeWord: boolean) => void;
	onFindNext: () => void;
	onFindPrevious: () => void;
	onSelectAllMatches: () => void;
	onReplaceNext: () => void;
	onReplaceAll: () => void;
	onClose: () => void;
}

function OptionToggle({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-medium leading-none transition-colors ${
				active
					? "bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/40"
					: "text-muted-foreground hover:bg-accent hover:text-foreground"
			}`}
		>
			{children}
		</button>
	);
}

export function CodeEditorSearchOverlay({
	isOpen,
	query,
	replaceText,
	caseSensitive,
	regexp,
	wholeWord,
	matchCount,
	activeMatchIndex,
	readOnly,
	onQueryChange,
	onReplaceTextChange,
	onCaseSensitiveChange,
	onRegexpChange,
	onWholeWordChange,
	onFindNext,
	onFindPrevious,
	onSelectAllMatches,
	onReplaceNext,
	onReplaceAll,
	onClose,
}: CodeEditorSearchOverlayProps) {
	const searchInputRef = useRef<HTMLInputElement>(null);
	const MIN_WIDTH = 400;
	const [width, setWidth] = useState(416); // default ~26rem
	const dragStartX = useRef<number | null>(null);
	const dragStartWidth = useRef<number>(416);

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
		if (!isOpen || !searchInputRef.current) {
			return;
		}

		searchInputRef.current.focus();
		searchInputRef.current.select();
	}, [isOpen]);

	const handleSearchInputKeyDown = (
		event: ReactKeyboardEvent<HTMLInputElement>,
	) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) {
				onFindPrevious();
			} else {
				onFindNext();
			}
		}
	};

	const handleReplaceInputKeyDown = (
		event: ReactKeyboardEvent<HTMLInputElement>,
	) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			onReplaceNext();
		}
	};

	if (!isOpen) {
		return null;
	}

	const activeMatchLabel =
		matchCount === 0
			? "No results"
			: `${Math.max(activeMatchIndex + 1, 1)} of ${matchCount}`;

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
			{/* Search row */}
			<div className="flex items-center gap-1">
				{/* Input + option toggles */}
				<div className="flex flex-1 items-center gap-0.5 rounded border border-border bg-background/80 px-1.5 py-0.5 focus-within:ring-1 focus-within:ring-blue-500/50">
					<input
						ref={searchInputRef}
						type="text"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={handleSearchInputKeyDown}
						placeholder="Find"
						className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
					/>
					<div className="flex items-center gap-0.5 pl-1">
						<OptionToggle
							active={caseSensitive}
							onClick={() => onCaseSensitiveChange(!caseSensitive)}
							title="Match Case (Alt+C)"
						>
							Aa
						</OptionToggle>
						<OptionToggle
							active={wholeWord}
							onClick={() => onWholeWordChange(!wholeWord)}
							title="Match Whole Word (Alt+W)"
						>
							ab|
						</OptionToggle>
						<OptionToggle
							active={regexp}
							onClick={() => onRegexpChange(!regexp)}
							title="Use Regular Expression (Alt+R)"
						>
							.*
						</OptionToggle>
					</div>
				</div>

				{/* Match count */}
				{query ? (
					<span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
						{activeMatchLabel}
					</span>
				) : null}

				{/* Navigation buttons */}
				<button
					type="button"
					onClick={onFindPrevious}
					title="Previous Match (Shift+Enter)"
					className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<HiChevronUp className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={onFindNext}
					title="Next Match (Enter)"
					className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<HiChevronDown className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={onSelectAllMatches}
					title="Select All Matches"
					className="h-6 rounded px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					All
				</button>
				<button
					type="button"
					onClick={onClose}
					title="Close (Escape)"
					className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					aria-label="Close search"
				>
					<HiMiniXMark className="size-4" />
				</button>
			</div>

			{/* Replace row */}
			{readOnly ? null : (
				<div className="mt-1 flex items-center gap-1">
					<div className="flex flex-1 items-center rounded border border-border bg-background/80 px-1.5 py-0.5 focus-within:ring-1 focus-within:ring-blue-500/50">
						<input
							type="text"
							value={replaceText}
							onChange={(event) => onReplaceTextChange(event.target.value)}
							onKeyDown={handleReplaceInputKeyDown}
							placeholder="Replace"
							className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
						/>
					</div>
					<button
						type="button"
						onClick={onReplaceNext}
						className="h-6 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Replace
					</button>
					<button
						type="button"
						onClick={onReplaceAll}
						className="h-6 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Replace All
					</button>
				</div>
			)}
			</div>
		</div>
	);
}
