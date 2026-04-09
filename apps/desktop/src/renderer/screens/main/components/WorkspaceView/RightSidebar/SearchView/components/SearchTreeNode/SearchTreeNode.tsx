import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { memo } from "react";
import {
	LuChevronDown,
	LuChevronRight,
	LuFolder,
	LuFolderOpen,
} from "react-icons/lu";
import type {
	SearchLineResult,
	SearchResultGroup,
	SearchTreeNode as SearchTreeNodeType,
} from "../../types";
import { SearchFileGroup } from "../SearchFileGroup";

interface SearchTreeNodeProps {
	node: SearchTreeNodeType;
	level?: number;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	isReplacing: boolean;
	showReplaceAction: boolean;
	openGroups: Record<string, boolean>;
	openFolders: Record<string, boolean>;
	onOpenGroupChange: (path: string, open: boolean) => void;
	onOpenFolderChange: (path: string, open: boolean) => void;
	onOpenMatch: (absolutePath: string, line: number, column: number) => void;
	onCopyFileLink: (group: SearchResultGroup) => void;
	onCopyMatchLink: (lineMatch: SearchLineResult) => void;
	onReplaceInFile: (absolutePath: string) => void;
	onReplaceMatch: (lineMatch: SearchLineResult) => void;
	onIgnoreMatch: (lineMatch: SearchLineResult) => void;
}

export const SearchTreeNode = memo(function SearchTreeNode({
	node,
	level = 0,
	query,
	isRegex,
	caseSensitive,
	isReplacing,
	showReplaceAction,
	openGroups,
	openFolders,
	onOpenGroupChange,
	onOpenFolderChange,
	onOpenMatch,
	onCopyFileLink,
	onCopyMatchLink,
	onReplaceInFile,
	onReplaceMatch,
	onIgnoreMatch,
}: SearchTreeNodeProps) {
	const indentPx = level * 8;
	const folderPath = node.type === "folder" ? node.path : null;
	const isOpen = folderPath ? (openFolders[folderPath] ?? true) : false;

	if (node.type === "file") {
		return (
			<div style={{ marginLeft: `${indentPx}px` }}>
				<SearchFileGroup
					group={node.group}
					isOpen={openGroups[node.group.absolutePath] ?? true}
					query={query}
					isRegex={isRegex}
					caseSensitive={caseSensitive}
					isReplacing={isReplacing}
					showReplaceAction={showReplaceAction}
					showParentPath={false}
					variant="tree"
					onOpenChange={(nextOpen) =>
						onOpenGroupChange(node.group.absolutePath, nextOpen)
					}
					onOpenMatch={onOpenMatch}
					onCopyFileLink={onCopyFileLink}
					onCopyMatchLink={onCopyMatchLink}
					onReplaceInFile={onReplaceInFile}
					onReplaceMatch={onReplaceMatch}
					onIgnoreMatch={onIgnoreMatch}
				/>
			</div>
		);
	}
	const FolderIcon = isOpen ? LuFolderOpen : LuFolder;

	return (
		<Collapsible
			open={isOpen}
			onOpenChange={(nextOpen) => onOpenFolderChange(node.path, nextOpen)}
		>
			<div style={{ marginLeft: `${indentPx}px` }}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs transition-colors hover:bg-accent/40"
					>
						<span className="shrink-0 text-muted-foreground">
							{isOpen ? (
								<LuChevronDown className="size-3.5" />
							) : (
								<LuChevronRight className="size-3.5" />
							)}
						</span>
						<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1 truncate text-foreground">
							{node.name}
						</span>
						<span className="shrink-0 text-[10px] leading-none tabular-nums text-muted-foreground">
							{node.matchCount}
						</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-0.5">
					{node.children.map((child) => (
						<SearchTreeNode
							key={child.id}
							node={child}
							level={level + 1}
							query={query}
							isRegex={isRegex}
							caseSensitive={caseSensitive}
							isReplacing={isReplacing}
							showReplaceAction={showReplaceAction}
							openGroups={openGroups}
							openFolders={openFolders}
							onOpenGroupChange={onOpenGroupChange}
							onOpenFolderChange={onOpenFolderChange}
							onOpenMatch={onOpenMatch}
							onCopyFileLink={onCopyFileLink}
							onCopyMatchLink={onCopyMatchLink}
							onReplaceInFile={onReplaceInFile}
							onReplaceMatch={onReplaceMatch}
							onIgnoreMatch={onIgnoreMatch}
						/>
					))}
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
});
