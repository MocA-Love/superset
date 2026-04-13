import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { HiChevronDown, HiChevronUp, HiMiniXMark } from "react-icons/hi2";

export interface BrowserFindOverlayHandle {
	focusInput: () => void;
}

interface BrowserFindOverlayProps {
	isOpen: boolean;
	query: string;
	matchCount: number;
	activeMatchOrdinal: number;
	matchCase: boolean;
	onQueryChange: (query: string) => void;
	onMatchCaseChange: (next: boolean) => void;
	onFindNext: () => void;
	onFindPrevious: () => void;
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

export const BrowserFindOverlay = forwardRef<
	BrowserFindOverlayHandle,
	BrowserFindOverlayProps
>(function BrowserFindOverlay(
	{
		isOpen,
		query,
		matchCount,
		activeMatchOrdinal,
		matchCase,
		onQueryChange,
		onMatchCaseChange,
		onFindNext,
		onFindPrevious,
		onClose,
	},
	ref,
) {
	const inputRef = useRef<HTMLInputElement>(null);

	useImperativeHandle(
		ref,
		() => ({
			focusInput: () => {
				inputRef.current?.focus();
				inputRef.current?.select();
			},
		}),
		[],
	);

	useEffect(() => {
		if (isOpen) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isOpen]);

	if (!isOpen) return null;

	const activeMatchLabel =
		matchCount === 0
			? query
				? "No results"
				: ""
			: `${Math.max(activeMatchOrdinal, 1)} of ${matchCount}`;

	return (
		<div
			className="absolute top-1 right-1 z-10 rounded bg-popover/95 shadow-lg ring-1 ring-border/40 backdrop-blur"
			style={{ width: "min(380px, calc(100% - 0.5rem))" }}
		>
			<div className="px-2 py-1.5">
				<div className="flex items-center gap-1">
					<div className="flex flex-1 items-center gap-0.5 rounded border border-border bg-background/80 px-1.5 py-0.5 focus-within:ring-1 focus-within:ring-blue-500/50">
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(event) => onQueryChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									if (event.shiftKey) onFindPrevious();
									else onFindNext();
								} else if (event.key === "Escape") {
									event.preventDefault();
									onClose();
								}
							}}
							placeholder="Find in page"
							className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
						/>
						<div className="flex items-center gap-0.5 pl-1">
							<OptionToggle
								active={matchCase}
								onClick={() => onMatchCaseChange(!matchCase)}
								title="Match Case"
							>
								Aa
							</OptionToggle>
						</div>
					</div>

					{query ? (
						<span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
							{activeMatchLabel}
						</span>
					) : null}

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
						onClick={onClose}
						title="Close (Escape)"
						className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						aria-label="Close search"
					>
						<HiMiniXMark className="size-4" />
					</button>
				</div>
			</div>
		</div>
	);
});
