import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceFileEvents } from "renderer/screens/main/components/WorkspaceView/hooks/useWorkspaceFileEvents";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useSearchDialogStore } from "renderer/stores/search-dialog-state";
import { SearchFileGroup } from "./components/SearchFileGroup";
import { SearchToolbar } from "./components/SearchToolbar";
import { useContentSearch } from "./hooks/useContentSearch";
import type { SearchContentResult, SearchResultGroup } from "./types";

function groupSearchResults(results: SearchContentResult[]): SearchResultGroup[] {
	const groups = new Map<string, SearchResultGroup>();

	for (const result of results) {
		const existing = groups.get(result.absolutePath);
		if (existing) {
			existing.matches.push(result);
			continue;
		}

		groups.set(result.absolutePath, {
			absolutePath: result.absolutePath,
			relativePath: result.relativePath,
			name: result.name,
			matches: [result],
		});
	}

	return Array.from(groups.values())
		.map((group) => ({
			...group,
			matches: [...group.matches].sort((left, right) => {
				if (left.line !== right.line) {
					return left.line - right.line;
				}
				return left.column - right.column;
			}),
		}))
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function buildReplaceSummary(input: {
	replacements: number;
	filesUpdated: number;
	conflictCount: number;
	failedCount: number;
}): string {
	const parts = [
		`Replaced ${input.replacements} match${input.replacements === 1 ? "" : "es"} in ${input.filesUpdated} file${input.filesUpdated === 1 ? "" : "s"}.`,
	];

	if (input.conflictCount > 0) {
		parts.push(
			`${input.conflictCount} file${input.conflictCount === 1 ? "" : "s"} changed on disk and were skipped.`,
		);
	}

	if (input.failedCount > 0) {
		parts.push(
			`${input.failedCount} file${input.failedCount === 1 ? "" : "s"} failed to update.`,
		);
	}

	return parts.join(" ");
}

export function SearchView({
	isActive,
	onOpenFileAtLine,
}: {
	isActive: boolean;
	onOpenFileAtLine: (path: string, line?: number, column?: number) => void;
}) {
	const workspaceId = useWorkspaceId();
	const utils = electronTrpc.useUtils();
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [replacement, setReplacement] = useState("");
	const [replaceOpen, setReplaceOpen] = useState(false);
	const [isRegex, setIsRegex] = useState(false);
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
	const includePattern = useSearchDialogStore(
		(state) => state.byMode.keywordSearch.includePattern,
	);
	const excludePattern = useSearchDialogStore(
		(state) => state.byMode.keywordSearch.excludePattern,
	);
	const setIncludePatternByMode = useSearchDialogStore(
		(state) => state.setIncludePattern,
	);
	const setExcludePatternByMode = useSearchDialogStore(
		(state) => state.setExcludePattern,
	);
	const replaceMutation = electronTrpc.filesystem.replaceContent.useMutation();

	const {
		searchResults,
		isFetching,
		hasQuery,
		validationError,
	} = useContentSearch({
		workspaceId,
		query,
		includePattern,
		excludePattern,
		isRegex,
		caseSensitive,
		enabled: isActive,
	});

	const groupedResults = useMemo(
		() => groupSearchResults(searchResults),
		[searchResults],
	);

	useEffect(() => {
		if (!isActive) {
			return;
		}

		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, [isActive]);

	useEffect(() => {
		if (groupedResults.length === 0) {
			return;
		}

		setOpenGroups((current) => {
			let changed = false;
			const nextGroups = { ...current };
			for (const group of groupedResults) {
				if (nextGroups[group.absolutePath] === undefined) {
					nextGroups[group.absolutePath] = true;
					changed = true;
				}
			}
			return changed ? nextGroups : current;
		});
	}, [groupedResults]);

	useWorkspaceFileEvents(
		workspaceId ?? "",
		() => {
			if (!query.trim()) {
				return;
			}
			void utils.filesystem.searchContent.invalidate();
		},
		Boolean(workspaceId && query.trim().length > 0),
	);

	const totalMatches = searchResults.length;
	const totalFiles = groupedResults.length;
	const canReplace =
		replaceOpen &&
		hasQuery &&
		validationError === null &&
		!replaceMutation.isPending;

	const runReplace = useCallback(
		async (paths?: string[]) => {
			if (!workspaceId || !query.trim() || validationError) {
				return;
			}

			try {
				const result = await replaceMutation.mutateAsync({
					workspaceId,
					query,
					replacement,
					includeHidden: false,
					includePattern,
					excludePattern,
					isRegex,
					caseSensitive,
					paths,
				});

				const summary = buildReplaceSummary({
					replacements: result.replacements,
					filesUpdated: result.filesUpdated,
					conflictCount: result.conflicts.length,
					failedCount: result.failed.length,
				});

				if (result.filesUpdated > 0) {
					if (result.conflicts.length > 0 || result.failed.length > 0) {
						toast.warning(summary);
					} else {
						toast.success(summary);
					}
				} else if (result.conflicts.length > 0 || result.failed.length > 0) {
					toast.error(summary);
				} else {
					toast.warning("No matches were replaced.");
				}

				void utils.filesystem.searchContent.invalidate();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to replace matches.",
				);
			}
		},
		[
			caseSensitive,
			excludePattern,
			includePattern,
			isRegex,
			query,
			replacement,
			replaceMutation,
			utils.filesystem.searchContent,
			validationError,
			workspaceId,
		],
	);

	const handleOpenGroupChange = useCallback(
		(absolutePath: string, nextOpen: boolean) => {
			setOpenGroups((current) => ({
				...current,
				[absolutePath]: nextOpen,
			}));
		},
		[],
	);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<SearchToolbar
				searchInputRef={searchInputRef}
				query={query}
				replacement={replacement}
				replaceOpen={replaceOpen}
				includePattern={includePattern}
				excludePattern={excludePattern}
				isRegex={isRegex}
				caseSensitive={caseSensitive}
				canReplaceAll={canReplace && totalMatches > 0}
				isReplacing={replaceMutation.isPending}
				onQueryChange={setQuery}
				onReplacementChange={setReplacement}
				onIncludePatternChange={(value) =>
					setIncludePatternByMode("keywordSearch", value)
				}
				onExcludePatternChange={(value) =>
					setExcludePatternByMode("keywordSearch", value)
				}
				onToggleReplace={() => setReplaceOpen((current) => !current)}
				onToggleRegex={() => setIsRegex((current) => !current)}
				onToggleCaseSensitive={() =>
					setCaseSensitive((current) => !current)
				}
				onReplaceAll={() => {
					void runReplace();
				}}
			/>

			<div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant="outline">{totalFiles} files</Badge>
					<Badge variant="secondary">{totalMatches} results</Badge>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					disabled={!hasQuery || validationError !== null || isFetching}
					onClick={() => {
						void utils.filesystem.searchContent.invalidate();
					}}
				>
					<LuRefreshCw className="size-3.5" />
				</Button>
			</div>

			{validationError ? (
				<div className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					Invalid regular expression: {validationError}
				</div>
			) : null}

			<ScrollArea className="flex-1 min-h-0">
				<div className="space-y-2 p-2">
					{!hasQuery ? (
						<div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
							Enter a search query to find matches across the workspace.
						</div>
					) : null}

					{hasQuery && validationError === null && groupedResults.length === 0 ? (
						<div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
							{isFetching ? "Searching workspace..." : "No results found."}
						</div>
					) : null}

					{groupedResults.map((group) => (
						<SearchFileGroup
							key={group.absolutePath}
							group={group}
							isOpen={openGroups[group.absolutePath] ?? true}
							query={query}
							isRegex={isRegex}
							caseSensitive={caseSensitive}
							isReplacing={replaceMutation.isPending}
							showReplaceAction={canReplace}
							onOpenChange={(nextOpen) =>
								handleOpenGroupChange(group.absolutePath, nextOpen)
							}
							onOpenMatch={onOpenFileAtLine}
							onReplaceInFile={(absolutePath) => {
								void runReplace([absolutePath]);
							}}
						/>
					))}
				</div>
			</ScrollArea>
		</div>
	);
}
