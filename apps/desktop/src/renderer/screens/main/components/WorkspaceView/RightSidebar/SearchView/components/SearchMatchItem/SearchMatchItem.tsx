import { cn } from "@superset/ui/utils";
import { memo, useMemo } from "react";
import { LuEyeOff, LuLink, LuReplace } from "react-icons/lu";
import type { RowHoverAction } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import { RowHoverActions } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import type { SearchLineResult } from "../../types";
import {
	buildLineReplacementSegments,
	highlightSearchText,
} from "../../utils/searchPattern/searchPattern";

interface SearchMatchItemProps {
	lineMatch: SearchLineResult;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
	isReplaceEnabled: boolean;
	/** When set, render the line as a before/after diff preview. */
	replacement?: string;
	variant?: "default" | "tree" | "list";
	onOpen: (absolutePath: string, line: number, column: number) => void;
	onCopyLink: (lineMatch: SearchLineResult) => void;
	onReplace: (lineMatch: SearchLineResult) => void;
	onIgnore: (lineMatch: SearchLineResult) => void;
}

export const SearchMatchItem = memo(function SearchMatchItem({
	lineMatch,
	query,
	isRegex,
	caseSensitive,
	wholeWord = false,
	multiline = false,
	isReplaceEnabled,
	replacement,
	variant = "default",
	onOpen,
	onCopyLink,
	onReplace,
	onIgnore,
}: SearchMatchItemProps) {
	const primaryMatch = lineMatch.matches[0];
	const showPreview = typeof replacement === "string" && replacement.length > 0;
	const previewSegments = useMemo(
		() =>
			showPreview
				? buildLineReplacementSegments(lineMatch.preview, {
						query,
						replacement: replacement ?? "",
						isRegex,
						caseSensitive,
						wholeWord,
						multiline,
					})
				: null,
		[
			showPreview,
			lineMatch.preview,
			query,
			replacement,
			isRegex,
			caseSensitive,
			wholeWord,
			multiline,
		],
	);
	const highlightedText = useMemo(
		() =>
			previewSegments
				? (() => {
						// Pre-compute running offsets so each segment gets a key that
						// embeds its absolute position in the line. That keeps keys
						// stable across renders without resorting to array indices
						// (which Biome flags) and works even when consecutive segments
						// share identical text.
						let offset = 0;
						return previewSegments.map((seg) => {
							const key = `${seg.kind}-${offset}`;
							offset += seg.text.length;
							if (seg.kind === "text") {
								return <span key={key}>{seg.text}</span>;
							}
							if (seg.kind === "match-before") {
								return (
									<del
										key={key}
										className="rounded bg-[var(--highlight-match)]/40 px-0.5 text-destructive line-through decoration-destructive/60"
									>
										{seg.text}
									</del>
								);
							}
							return (
								<ins
									key={key}
									className="rounded bg-emerald-500/15 px-0.5 text-emerald-700 no-underline dark:text-emerald-300"
								>
									{seg.text}
								</ins>
							);
						});
					})()
				: highlightSearchText(lineMatch.preview, {
						query,
						isRegex,
						caseSensitive,
						wholeWord,
						multiline,
					}),
		[
			previewSegments,
			lineMatch.preview,
			query,
			isRegex,
			caseSensitive,
			wholeWord,
			multiline,
		],
	);
	const hoverActions: RowHoverAction[] = [
		...(isReplaceEnabled
			? [
					{
						key: "replace",
						label: "Replace match",
						icon: <LuReplace className="size-3.5" />,
						onClick: () => onReplace(lineMatch),
					},
				]
			: []),
		{
			key: "copy-link",
			label: "Copy Superset link",
			icon: <LuLink className="size-3.5" />,
			onClick: () => onCopyLink(lineMatch),
		},
		{
			key: "ignore",
			label: "Ignore result",
			icon: <LuEyeOff className="size-3.5" />,
			onClick: () => onIgnore(lineMatch),
		},
	];
	const isCompactVariant = variant === "tree" || variant === "list";

	return (
		<div
			className={cn(
				"group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 rounded-md transition-colors hover:bg-accent/50",
				isCompactVariant && "gap-0.5 rounded-sm",
			)}
		>
			<button
				type="button"
				className={cn(
					"flex min-w-0 w-full items-start gap-2 rounded-md px-2 py-2 text-left",
					isCompactVariant && "gap-1.5 rounded-sm px-1 py-1 text-xs",
				)}
				onClick={() =>
					onOpen(
						lineMatch.absolutePath,
						lineMatch.line,
						primaryMatch?.column ?? 1,
					)
				}
			>
				<div className="min-w-0 flex-1 text-xs leading-5 text-foreground">
					<div
						className={cn("break-words pr-1", isCompactVariant && "leading-4")}
					>
						{highlightedText}
					</div>
				</div>
			</button>
			<div className="flex self-center items-center pr-1">
				<RowHoverActions actions={hoverActions} />
			</div>
		</div>
	);
});
