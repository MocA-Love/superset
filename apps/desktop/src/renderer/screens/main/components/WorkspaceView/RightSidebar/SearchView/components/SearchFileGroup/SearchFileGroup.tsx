import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { memo } from "react";
import {
	LuChevronDown,
	LuChevronRight,
	LuLink,
	LuReplace,
} from "react-icons/lu";
import type { RowHoverAction } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import { RowHoverActions } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RowHoverActions";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";
import type { SearchLineResult, SearchResultGroup } from "../../types";
import { SearchMatchItem } from "../SearchMatchItem";

interface SearchFileGroupProps {
	group: SearchResultGroup;
	isOpen: boolean;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	isReplacing: boolean;
	showReplaceAction: boolean;
	showParentPath?: boolean;
	variant?: "default" | "tree" | "list";
	onOpenChange: (open: boolean) => void;
	onOpenMatch: (absolutePath: string, line: number, column: number) => void;
	onCopyFileLink: (group: SearchResultGroup) => void;
	onCopyMatchLink: (lineMatch: SearchLineResult) => void;
	onReplaceInFile: (absolutePath: string) => void;
	onReplaceMatch: (lineMatch: SearchLineResult) => void;
	onIgnoreMatch: (lineMatch: SearchLineResult) => void;
}

function getParentPath(relativePath: string): string {
	const segments = relativePath.split(/[\\/]/);
	if (segments.length <= 1) {
		return ".";
	}
	return segments.slice(0, -1).join("/");
}

function groupMatchesByLine(group: SearchResultGroup): SearchLineResult[] {
	const lineMap = new Map<number, SearchLineResult>();

	for (const match of group.matches) {
		const existing = lineMap.get(match.line);
		if (existing) {
			existing.matches.push(match);
			continue;
		}

		lineMap.set(match.line, {
			id: `${group.absolutePath}:${match.line}`,
			absolutePath: group.absolutePath,
			relativePath: group.relativePath,
			name: group.name,
			line: match.line,
			preview: match.preview,
			matches: [match],
		});
	}

	return Array.from(lineMap.values()).sort(
		(left, right) => left.line - right.line,
	);
}

export const SearchFileGroup = memo(function SearchFileGroup({
	group,
	isOpen,
	query,
	isRegex,
	caseSensitive,
	isReplacing,
	showReplaceAction,
	showParentPath = true,
	variant = "default",
	onOpenChange,
	onOpenMatch,
	onCopyFileLink,
	onCopyMatchLink,
	onReplaceInFile,
	onReplaceMatch,
	onIgnoreMatch,
}: SearchFileGroupProps) {
	const parentPath = getParentPath(group.relativePath);
	const matchCount = group.matches.length;
	const hoverActions: RowHoverAction[] = [
		{
			key: "copy-file-link",
			label: "Copy Superset link",
			icon: <LuLink className="size-3.5" />,
			onClick: () => onCopyFileLink(group),
		},
		...(showReplaceAction
			? [
					{
						key: "replace-file",
						label: "Replace in file",
						icon: <LuReplace className="size-3.5" />,
						onClick: () => onReplaceInFile(group.absolutePath),
						disabled: isReplacing,
					},
				]
			: []),
	];
	const isTreeVariant = variant === "tree";
	const isListVariant = variant === "list";
	const lineMatches = groupMatchesByLine(group);

	return (
		<Collapsible open={isOpen} onOpenChange={onOpenChange}>
			<div
				className={
					isTreeVariant
						? "rounded-sm"
						: isListVariant
							? "rounded-sm"
							: "rounded-md border border-border/60 bg-background/60"
				}
			>
				<div
					className={
						isTreeVariant
							? "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 py-0.5"
							: isListVariant
								? "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 py-0.5"
								: "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-1.5 py-1.5"
					}
				>
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className={
								isTreeVariant
									? "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-xs transition-colors hover:bg-accent/40"
									: isListVariant
										? "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-xs transition-colors hover:bg-accent/40"
										: "flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40"
							}
						>
							<span
								className={
									isTreeVariant
										? "shrink-0 text-muted-foreground"
										: isListVariant
											? "shrink-0 text-muted-foreground"
											: "mt-0.5 shrink-0 text-muted-foreground"
								}
							>
								{isOpen ? (
									<LuChevronDown className="size-3.5" />
								) : (
									<LuChevronRight className="size-3.5" />
								)}
							</span>
							<FileIcon
								fileName={group.name}
								className={
									isTreeVariant || isListVariant
										? "size-4 shrink-0"
										: "mt-0.5 size-4 shrink-0"
								}
							/>
							<div className="min-w-0 flex-1">
								{isListVariant ? (
									<div className="flex min-w-0 items-center gap-1.5">
										<div className="truncate text-xs text-foreground">
											{group.name}
										</div>
										{showParentPath ? (
											<div className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">
												{parentPath}
											</div>
										) : null}
									</div>
								) : (
									<>
										<div
											className={
												isTreeVariant
													? "truncate text-xs text-foreground"
													: "truncate text-sm font-medium text-foreground"
											}
										>
											{group.name}
										</div>
										{showParentPath ? (
											<div className="truncate text-xs text-muted-foreground">
												{parentPath}
											</div>
										) : null}
									</>
								)}
							</div>
						</button>
					</CollapsibleTrigger>
					<div className="flex self-center items-center justify-end pl-1">
						<div className="relative flex h-5 min-w-5 items-center justify-end">
							<span
								className={
									showReplaceAction
										? "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/70 bg-background/80 px-1.5 text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
										: "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/70 bg-background/80 px-1.5 text-[10px] leading-none tabular-nums text-muted-foreground"
								}
							>
								{matchCount}
							</span>
							<div className="absolute inset-0 flex items-center justify-end">
								<RowHoverActions actions={hoverActions} />
							</div>
						</div>
					</div>
				</div>
				<CollapsibleContent
					className={
						isTreeVariant
							? "ml-4 border-l border-border/50 pl-2"
							: isListVariant
								? "ml-4 border-l border-border/50 pl-2"
								: "border-t border-border/50 px-1.5 py-1"
					}
				>
					<div className="space-y-1">
						{lineMatches.map((lineMatch) => (
							<SearchMatchItem
								key={lineMatch.id}
								lineMatch={lineMatch}
								query={query}
								isRegex={isRegex}
								caseSensitive={caseSensitive}
								isReplaceEnabled={showReplaceAction && !isReplacing}
								variant={
									isTreeVariant ? "tree" : isListVariant ? "list" : "default"
								}
								onOpen={onOpenMatch}
								onCopyLink={onCopyMatchLink}
								onReplace={onReplaceMatch}
								onIgnore={onIgnoreMatch}
							/>
						))}
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
});
