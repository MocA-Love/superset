import { useDebouncedValue } from "renderer/hooks/useDebouncedValue";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SEARCH_RESULT_LIMIT } from "../../constants";

interface UseFileSearchParams {
	workspaceId: string | undefined;
	searchTerm: string;
	includePattern?: string;
	excludePattern?: string;
	limit?: number;
	/** Absolute paths currently open in the editor; boosted in ranking. */
	openFilePaths?: string[];
	/** Absolute paths recently viewed, most-recent-first; boosted in ranking. */
	recentFilePaths?: string[];
	/**
	 * Logical caller identity. Defaults to "files-tab"; Cmd+P passes
	 * "quick-open" so the two UI surfaces don't cancel each other's searches
	 * when they land on the same workspace concurrently.
	 */
	scopeId?: string;
}

export function useFileSearch({
	workspaceId,
	searchTerm,
	includePattern = "",
	excludePattern = "",
	limit = SEARCH_RESULT_LIMIT,
	openFilePaths,
	recentFilePaths,
	scopeId = "files-tab",
}: UseFileSearchParams) {
	const trimmedQuery = searchTerm.trim();
	const debouncedQuery = useDebouncedValue(trimmedQuery, 150);
	const isDebouncing =
		trimmedQuery.length > 0 && trimmedQuery !== debouncedQuery;

	const { data: searchResults, isFetching } =
		electronTrpc.filesystem.searchFiles.useQuery(
			{
				workspaceId: workspaceId ?? "",
				query: debouncedQuery,
				includePattern,
				excludePattern,
				limit,
				openFilePaths,
				recentFilePaths,
				scopeId,
			},
			{
				enabled: Boolean(workspaceId) && debouncedQuery.length > 0,
				staleTime: 1000,
				placeholderData: (previous) => previous ?? { matches: [] },
			},
		);

	const results =
		searchResults?.matches.map((match) => ({
			id: match.absolutePath,
			name: match.name,
			path: match.absolutePath,
			relativePath: match.relativePath,
			isDirectory: match.kind === "directory",
			score: match.score,
		})) ?? [];

	return {
		searchResults: results,
		isFetching: isFetching || isDebouncing,
		hasQuery: trimmedQuery.length > 0,
	};
}
