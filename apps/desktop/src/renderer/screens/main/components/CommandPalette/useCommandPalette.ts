import type { UseNavigateResult } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebouncedValue } from "renderer/hooks/useDebouncedValue";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getWorkspaceDisplayName } from "renderer/lib/getWorkspaceDisplayName";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { useFileSearch } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/hooks/useFileSearch/useFileSearch";
import { useFileExplorerStore } from "renderer/stores/file-explorer";
import {
	type SearchScope,
	useSearchDialogStore,
} from "renderer/stores/search-dialog-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { parseQuickOpenQuery } from "./parseQuickOpenQuery";

const SEARCH_LIMIT = 50;

interface UseCommandPaletteParams {
	workspaceId: string;
	navigate: UseNavigateResult<string>;
	enabled?: boolean;
	onSelectFile?: (input: {
		filePath: string;
		targetWorkspaceId: string;
		line?: number;
		column?: number;
		close: () => void;
		navigate: UseNavigateResult<string>;
	}) => void;
	/**
	 * Absolute paths currently open in the editor. Forwarded to `searchFiles`
	 * so VSCode-style Quick Open boosts them above unrelated hits.
	 */
	openFilePaths?: readonly string[];
	/**
	 * Absolute paths ordered most-recent-first. Forwarded to `searchFiles` for
	 * MRU boosting and tiebreaking.
	 */
	recentFilePaths?: readonly string[];
}

export function useCommandPalette({
	workspaceId,
	navigate,
	enabled = true,
	onSelectFile,
	openFilePaths,
	recentFilePaths,
}: UseCommandPaletteParams) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const includePattern = useSearchDialogStore(
		(state) => state.byMode.quickOpen.includePattern,
	);
	const excludePattern = useSearchDialogStore(
		(state) => state.byMode.quickOpen.excludePattern,
	);
	const filtersOpen = useSearchDialogStore(
		(state) => state.byMode.quickOpen.filtersOpen,
	);
	const scope =
		useSearchDialogStore((state) => state.byMode.quickOpen.scope) ??
		"workspace";
	const setIncludePatternByMode = useSearchDialogStore(
		(state) => state.setIncludePattern,
	);
	const setExcludePatternByMode = useSearchDialogStore(
		(state) => state.setExcludePattern,
	);
	const setFiltersOpenByMode = useSearchDialogStore(
		(state) => state.setFiltersOpen,
	);
	const setScopeByMode = useSearchDialogStore((state) => state.setScope);

	// Fetch all grouped workspaces (only when global scope is active and dialog is open)
	const { data: allGrouped } = electronTrpc.workspaces.getAllGrouped.useQuery(
		undefined,
		{
			enabled: open && scope === "global",
		},
	);

	// Kick off a background index build whenever Cmd+P is opened. The backend
	// deduplicates concurrent builds via its in-flight Promise cache and the
	// TTL (30s), so firing this on every open is cheap and keeps results
	// instant even after the cache expires between uses.
	const warmupMutation =
		electronTrpc.filesystem.warmupSearchIndex.useMutation();
	const warmupMutate = warmupMutation.mutate;
	useEffect(() => {
		if (!open || !workspaceId) {
			return;
		}
		warmupMutate({ workspaceId });
	}, [open, workspaceId, warmupMutate]);

	// Build roots array for multi-workspace search
	const roots = useMemo(() => {
		if (scope !== "global" || !allGrouped) return [];
		const result: {
			rootPath: string;
			workspaceId: string;
			workspaceName: string;
		}[] = [];
		for (const group of allGrouped) {
			const addWorkspace = (ws: {
				id: string;
				worktreePath: string;
				name: string;
				type: "worktree" | "branch";
			}) => {
				if (ws.worktreePath) {
					result.push({
						rootPath: ws.worktreePath,
						workspaceId: ws.id,
						workspaceName: getWorkspaceDisplayName(
							ws.name,
							ws.type,
							group.project.name,
						),
					});
				}
			};
			for (const ws of group.workspaces) {
				addWorkspace(ws);
			}
			for (const section of group.sections) {
				for (const ws of section.workspaces) {
					addWorkspace(ws);
				}
			}
		}
		return result;
	}, [scope, allGrouped]);

	// Stabilize identity of the MRU/open arrays across renders. Joining into a
	// single sentinel string is cheap and means React Query only re-fetches
	// when the actual set of paths changes, not on every parent render.
	const openFilePathsKey = useMemo(
		() => (openFilePaths ? openFilePaths.join("\u0000") : ""),
		[openFilePaths],
	);
	const recentFilePathsKey = useMemo(
		() => (recentFilePaths ? recentFilePaths.join("\u0000") : ""),
		[recentFilePaths],
	);
	const openFilePathsList = useMemo(
		() =>
			openFilePathsKey.length > 0
				? openFilePathsKey.split("\u0000")
				: undefined,
		[openFilePathsKey],
	);
	const recentFilePathsList = useMemo(
		() =>
			recentFilePathsKey.length > 0
				? recentFilePathsKey.split("\u0000")
				: undefined,
		[recentFilePathsKey],
	);

	const includeIgnored = useFileExplorerStore((s) => s.includeIgnored);
	const toggleIncludeIgnored = useFileExplorerStore(
		(s) => s.toggleIncludeIgnored,
	);
	const parsedQuery = useMemo(() => parseQuickOpenQuery(query), [query]);
	const searchQuery = parsedQuery.searchQuery;

	// Single-workspace search (existing behavior)
	const singleSearch = useFileSearch({
		workspaceId: open && scope === "workspace" ? workspaceId : undefined,
		searchTerm: searchQuery,
		includePattern,
		excludePattern,
		limit: SEARCH_LIMIT,
		openFilePaths: openFilePathsList,
		recentFilePaths: recentFilePathsList,
		scopeId: "quick-open",
		includeIgnored,
	});

	// Multi-workspace search. Note that MRU/open boosts aren't forwarded here
	// because the recency lists are scoped to the current workspace; applying
	// them across other workspaces would mis-rank unrelated paths.
	const debouncedQuery = useDebouncedValue(searchQuery, 150);
	const multiSearchQueries = electronTrpc.useQueries((t) =>
		open && scope === "global" && roots.length > 0 && debouncedQuery.length > 0
			? roots.map((root) =>
					t.filesystem.searchFiles({
						workspaceId: root.workspaceId,
						query: debouncedQuery,
						includePattern,
						excludePattern,
						limit: SEARCH_LIMIT,
						scopeId: "quick-open-global",
						includeHidden: includeIgnored,
					}),
				)
			: [],
	);

	const multiSearchResults = useMemo(
		() =>
			roots
				.flatMap((root, index) =>
					(multiSearchQueries[index]?.data?.matches ?? []).map((match) => ({
						id: match.absolutePath,
						name: match.name,
						path: match.absolutePath,
						relativePath: match.relativePath,
						isDirectory: match.kind === "directory",
						score: match.score,
						workspaceId: root.workspaceId,
						workspaceName: root.workspaceName,
					})),
				)
				.sort((left, right) => right.score - left.score)
				.slice(0, SEARCH_LIMIT),
		[roots, multiSearchQueries],
	);

	const searchResults =
		scope === "workspace" ? singleSearch.searchResults : multiSearchResults;
	const isFetching =
		scope === "workspace"
			? singleSearch.isFetching
			: multiSearchQueries.some((query) => query.isFetching) ||
				(searchQuery.length > 0 && searchQuery !== debouncedQuery);

	const handleOpenChange = useCallback((nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setQuery("");
		}
	}, []);

	useEffect(() => {
		if (!enabled) {
			handleOpenChange(false);
		}
	}, [enabled, handleOpenChange]);

	const toggle = useCallback(() => {
		if (!enabled) return;
		setOpen((prev) => {
			if (prev) {
				setQuery("");
			}
			return !prev;
		});
	}, [enabled]);

	const selectFile = useCallback(
		(filePath: string, resultWorkspaceId?: string) => {
			const targetWs = resultWorkspaceId ?? workspaceId;
			if (onSelectFile) {
				onSelectFile({
					filePath,
					targetWorkspaceId: targetWs,
					line: parsedQuery.line,
					column: parsedQuery.column,
					close: () => handleOpenChange(false),
					navigate,
				});
				return;
			}
			useTabsStore.getState().addFileViewerPane(targetWs, {
				filePath,
				line: parsedQuery.line,
				column: parsedQuery.column,
				useRightSidebarOpenViewWidth: true,
			});
			handleOpenChange(false);
			if (targetWs !== workspaceId) {
				navigateToWorkspace(targetWs, navigate);
			}
		},
		[
			workspaceId,
			onSelectFile,
			handleOpenChange,
			navigate,
			parsedQuery.line,
			parsedQuery.column,
		],
	);

	const setIncludePattern = useCallback(
		(value: string) => {
			setIncludePatternByMode("quickOpen", value);
		},
		[setIncludePatternByMode],
	);

	const setExcludePattern = useCallback(
		(value: string) => {
			setExcludePatternByMode("quickOpen", value);
		},
		[setExcludePatternByMode],
	);

	const setFiltersOpen = useCallback(
		(nextOpen: boolean) => {
			setFiltersOpenByMode("quickOpen", nextOpen);
		},
		[setFiltersOpenByMode],
	);

	const setScope = useCallback(
		(newScope: SearchScope) => {
			setScopeByMode("quickOpen", newScope);
		},
		[setScopeByMode],
	);

	return {
		open,
		query,
		setQuery,
		filtersOpen,
		setFiltersOpen,
		includePattern,
		setIncludePattern,
		excludePattern,
		setExcludePattern,
		handleOpenChange,
		toggle,
		selectFile,
		searchResults,
		isFetching,
		scope,
		setScope,
		includeIgnored,
		toggleIncludeIgnored,
	};
}
