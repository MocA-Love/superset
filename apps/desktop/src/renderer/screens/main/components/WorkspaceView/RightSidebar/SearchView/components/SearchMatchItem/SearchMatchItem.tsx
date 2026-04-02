import { cn } from "@superset/ui/utils";
import { memo, useMemo } from "react";
import { LuEyeOff, LuLink, LuReplace } from "react-icons/lu";
import type { RowHoverAction } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import { RowHoverActions } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import type { SearchLineResult } from "../../types";
import { highlightSearchText } from "../../utils/searchPattern/searchPattern";

interface SearchMatchItemProps {
	lineMatch: SearchLineResult;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	isReplaceEnabled: boolean;
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
	isReplaceEnabled,
	variant = "default",
	onOpen,
	onCopyLink,
	onReplace,
	onIgnore,
}: SearchMatchItemProps) {
	const primaryMatch = lineMatch.matches[0];
	const highlightedText = useMemo(
		() =>
			highlightSearchText(lineMatch.preview, { query, isRegex, caseSensitive }),
		[lineMatch.preview, query, isRegex, caseSensitive],
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
