import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useRef,
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
		<div className="absolute top-1 right-1 z-10 max-w-[min(48rem,calc(100%-0.5rem))] rounded bg-popover/95 px-2 py-1 shadow-lg ring-1 ring-border/40 backdrop-blur">
			<div className="flex flex-wrap items-center gap-1">
				<input
					ref={searchInputRef}
					type="text"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={handleSearchInputKeyDown}
					placeholder="Find"
					className="h-6 min-w-0 w-36 rounded border border-border bg-background/80 px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
				/>
				<button
					type="button"
					onClick={onFindNext}
					className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent"
				>
					<HiChevronDown className="size-3.5" />
					<span>Next</span>
				</button>
				<button
					type="button"
					onClick={onFindPrevious}
					className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent"
				>
					<HiChevronUp className="size-3.5" />
					<span>Previous</span>
				</button>
				<button
					type="button"
					onClick={onSelectAllMatches}
					className="h-6 rounded border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent"
				>
					All
				</button>
				{query ? (
					<span className="px-1 text-xs text-muted-foreground whitespace-nowrap">
						{activeMatchLabel}
					</span>
				) : null}
				<button
					type="button"
					onClick={onClose}
					className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					aria-label="Close search"
				>
					<HiMiniXMark className="size-4" />
				</button>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<label className="inline-flex items-center gap-1">
					<input
						type="checkbox"
						checked={caseSensitive}
						onChange={(event) => onCaseSensitiveChange(event.target.checked)}
					/>
					<span>Match case</span>
				</label>
				<label className="inline-flex items-center gap-1">
					<input
						type="checkbox"
						checked={regexp}
						onChange={(event) => onRegexpChange(event.target.checked)}
					/>
					<span>Regexp</span>
				</label>
				<label className="inline-flex items-center gap-1">
					<input
						type="checkbox"
						checked={wholeWord}
						onChange={(event) => onWholeWordChange(event.target.checked)}
					/>
					<span>By word</span>
				</label>
			</div>
			{readOnly ? null : (
				<div className="mt-1 flex flex-wrap items-center gap-1">
					<input
						type="text"
						value={replaceText}
						onChange={(event) => onReplaceTextChange(event.target.value)}
						onKeyDown={handleReplaceInputKeyDown}
						placeholder="Replace"
						className="h-6 min-w-0 w-36 rounded border border-border bg-background/80 px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
					/>
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
	);
}
