import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import type { ReactNode, RefObject } from "react";
import { LuReplace, LuSearch, LuX } from "react-icons/lu";
import { PiTextAa } from "react-icons/pi";
import { TbRegex } from "react-icons/tb";

interface SearchToolbarProps {
	searchInputRef: RefObject<HTMLInputElement | null>;
	query: string;
	replacement: string;
	replaceOpen: boolean;
	includePattern: string;
	excludePattern: string;
	isRegex: boolean;
	caseSensitive: boolean;
	canReplaceAll: boolean;
	isReplacing: boolean;
	onQueryChange: (value: string) => void;
	onReplacementChange: (value: string) => void;
	onIncludePatternChange: (value: string) => void;
	onExcludePatternChange: (value: string) => void;
	onToggleReplace: () => void;
	onToggleRegex: () => void;
	onToggleCaseSensitive: () => void;
	onReplaceAll: () => void;
}

function ToggleIconButton({
	label,
	isActive,
	onClick,
	children,
}: {
	label: string;
	isActive: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={cn(
						"size-8 shrink-0 text-muted-foreground",
						isActive && "bg-accent text-accent-foreground",
					)}
					aria-pressed={isActive}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export function SearchToolbar({
	searchInputRef,
	query,
	replacement,
	replaceOpen,
	includePattern,
	excludePattern,
	isRegex,
	caseSensitive,
	canReplaceAll,
	isReplacing,
	onQueryChange,
	onReplacementChange,
	onIncludePatternChange,
	onExcludePatternChange,
	onToggleReplace,
	onToggleRegex,
	onToggleCaseSensitive,
	onReplaceAll,
}: SearchToolbarProps) {
	return (
		<div className="shrink-0 border-b px-2 py-2">
			<div className="flex items-center gap-1">
				<div className="relative min-w-0 flex-1">
					<LuSearch className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						ref={searchInputRef}
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search in files"
						className="h-8 pl-8 pr-8 text-sm"
					/>
					{query.length > 0 ? (
						<button
							type="button"
							className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							onClick={() => onQueryChange("")}
						>
							<LuX className="size-3.5" />
						</button>
					) : null}
				</div>
				<ToggleIconButton
					label={replaceOpen ? "Hide replace" : "Show replace"}
					isActive={replaceOpen}
					onClick={onToggleReplace}
				>
					<LuReplace className="size-4" />
				</ToggleIconButton>
				<ToggleIconButton
					label="Match case"
					isActive={caseSensitive}
					onClick={onToggleCaseSensitive}
				>
					<PiTextAa className="size-4" />
				</ToggleIconButton>
				<ToggleIconButton
					label="Use regular expression"
					isActive={isRegex}
					onClick={onToggleRegex}
				>
					<TbRegex className="size-4" />
				</ToggleIconButton>
			</div>

			{replaceOpen ? (
				<div className="mt-2 flex items-center gap-2">
					<Input
						value={replacement}
						onChange={(event) => onReplacementChange(event.target.value)}
						placeholder="Replace"
						className="h-8 min-w-0 flex-1 text-sm"
					/>
					<Button
						type="button"
						size="sm"
						className="h-8 shrink-0"
						disabled={!canReplaceAll || isReplacing}
						onClick={onReplaceAll}
					>
						Replace All
					</Button>
				</div>
			) : null}

			<div className="mt-2 grid gap-1">
				<Input
					value={includePattern}
					onChange={(event) => onIncludePatternChange(event.target.value)}
					placeholder="files to include (glob)"
					className="h-7 text-xs"
				/>
				<Input
					value={excludePattern}
					onChange={(event) => onExcludePatternChange(event.target.value)}
					placeholder="files to exclude (glob)"
					className="h-7 text-xs"
				/>
			</div>
		</div>
	);
}
