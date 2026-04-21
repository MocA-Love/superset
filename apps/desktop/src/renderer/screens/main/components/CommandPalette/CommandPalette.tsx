import { Button } from "@superset/ui/button";
import { CommandSeparator } from "@superset/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useMemo } from "react";
import { LuEye, LuEyeOff } from "react-icons/lu";
import {
	RECENT_DISPLAY_LIMIT,
	type RecentFile,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useRecentlyViewedFiles";
import {
	SearchDialog,
	type SearchDialogItem,
} from "renderer/screens/main/components/SearchDialog";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";
import type { SearchScope } from "renderer/stores/search-dialog-state";
import { FileResultItem } from "./components/FileResultItem";
import { ScopeToggle } from "./components/ScopeToggle";

function getFileName(relativePath: string): string {
	const segments = relativePath.split("/");
	return segments[segments.length - 1] ?? relativePath;
}

interface CommandPaletteResult extends SearchDialogItem {
	name: string;
	relativePath: string;
	path: string;
	isDirectory: boolean;
	score: number;
	workspaceId?: string;
	workspaceName?: string;
}

interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	query: string;
	onQueryChange: (query: string) => void;
	filtersOpen: boolean;
	onFiltersOpenChange: (open: boolean) => void;
	includePattern: string;
	onIncludePatternChange: (value: string) => void;
	excludePattern: string;
	onExcludePatternChange: (value: string) => void;
	isLoading: boolean;
	searchResults: CommandPaletteResult[];
	onSelectFile: (filePath: string, workspaceId?: string) => void;
	scope: SearchScope;
	onScopeChange: (scope: SearchScope) => void;
	workspaceName?: string;
	recentlyViewedFiles?: RecentFile[];
	openFilePaths?: Set<string>;
	includeIgnored?: boolean;
	onToggleIncludeIgnored?: () => void;
}

export function CommandPalette({
	open,
	onOpenChange,
	query,
	onQueryChange,
	filtersOpen,
	onFiltersOpenChange,
	includePattern,
	onIncludePatternChange,
	excludePattern,
	onExcludePatternChange,
	isLoading,
	searchResults,
	onSelectFile,
	scope,
	onScopeChange,
	workspaceName,
	recentlyViewedFiles,
	openFilePaths,
	includeIgnored = false,
	onToggleIncludeIgnored,
}: CommandPaletteProps) {
	const trimmedQuery = query.trim();
	const hasQuery = trimmedQuery.length > 0;
	const showRecentSection =
		scope === "workspace" && Boolean(recentlyViewedFiles);

	const orderedRecent = useMemo<RecentFile[]>(() => {
		if (!showRecentSection || !recentlyViewedFiles) return [];
		const openSet = openFilePaths ?? new Set<string>();
		const openFiles: RecentFile[] = [];
		const rest: RecentFile[] = [];
		for (const file of recentlyViewedFiles) {
			if (openSet.has(file.absolutePath)) {
				openFiles.push(file);
			} else {
				rest.push(file);
			}
		}
		return [...openFiles, ...rest].slice(0, RECENT_DISPLAY_LIMIT);
	}, [showRecentSection, recentlyViewedFiles, openFilePaths]);

	const filteredRecent = useMemo<RecentFile[]>(() => {
		if (!showRecentSection) return [];
		if (!hasQuery) return orderedRecent;
		const needle = trimmedQuery.toLowerCase();
		return orderedRecent.filter((file) =>
			file.relativePath.toLowerCase().includes(needle),
		);
	}, [showRecentSection, hasQuery, trimmedQuery, orderedRecent]);

	const recentAbsSet = useMemo(
		() => new Set(filteredRecent.map((f) => f.absolutePath)),
		[filteredRecent],
	);

	const dedupedResults = useMemo(() => {
		if (!showRecentSection) return searchResults;
		return searchResults.filter((r) => !recentAbsSet.has(r.path));
	}, [showRecentSection, searchResults, recentAbsSet]);

	const preResultsSection = showRecentSection && filteredRecent.length > 0 && (
		<>
			<div className="px-2 pt-2 pb-1 text-muted-foreground text-xs">
				Recently Viewed
			</div>
			{filteredRecent.map((file) => (
				<FileResultItem
					key={`recent:${file.absolutePath}`}
					value={`recent:${file.absolutePath}`}
					fileName={getFileName(file.relativePath)}
					relativePath={file.relativePath}
					onSelect={() => onSelectFile(file.absolutePath)}
				/>
			))}
			{dedupedResults.length > 0 && (
				<CommandSeparator alwaysRender className="my-1" />
			)}
		</>
	);

	return (
		<SearchDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Quick Open"
			description={
				scope === "global"
					? "Search for files across all workspaces"
					: "Search for files in your workspace"
			}
			query={query}
			onQueryChange={onQueryChange}
			queryPlaceholder={
				scope === "global" ? "Search all workspaces..." : "Search files..."
			}
			filtersOpen={filtersOpen}
			onFiltersOpenChange={onFiltersOpenChange}
			contentClassName="sm:max-w-5xl top-[30%] translate-y-0"
			listClassName="max-h-[600px]"
			includePattern={includePattern}
			onIncludePatternChange={onIncludePatternChange}
			excludePattern={excludePattern}
			onExcludePatternChange={onExcludePatternChange}
			emptyMessage="No files found."
			isLoading={isLoading}
			results={dedupedResults}
			getItemValue={(file) => file.path}
			onSelectItem={(file) => onSelectFile(file.path, file.workspaceId)}
			preResultsSection={preResultsSection}
			hasPreResults={filteredRecent.length > 0}
			headerExtra={
				<div className="flex items-center gap-1 pr-2">
					<ScopeToggle
						scope={scope}
						onScopeChange={onScopeChange}
						workspaceName={workspaceName}
					/>
					{onToggleIncludeIgnored && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className={`ml-auto size-6 ${
										includeIgnored ? "bg-accent" : ""
									}`}
									onClick={onToggleIncludeIgnored}
								>
									{includeIgnored ? (
										<LuEye className="size-3.5" />
									) : (
										<LuEyeOff className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{includeIgnored
									? "Hide .gitignored & hidden files"
									: "Show .gitignored & hidden files"}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			}
			renderItem={(file) => {
				return (
					<>
						<FileIcon fileName={file.name} className="size-3.5 shrink-0" />
						<span className="truncate font-medium">{file.name}</span>
						{scope === "global" && file.workspaceName && (
							<span className="shrink-0 text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
								{file.workspaceName}
							</span>
						)}
						<span className="truncate text-muted-foreground text-xs ml-auto">
							{file.relativePath}
						</span>
					</>
				);
			}}
		/>
	);
}
