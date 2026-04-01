import { useMemo } from "react";
import { useDebouncedValue } from "renderer/hooks/useDebouncedValue";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { SearchContentResult } from "../../types";
import { getSearchValidationError } from "../../utils/searchPattern/searchPattern";

const DEFAULT_SEARCH_LIMIT = 500;

interface UseContentSearchParams {
	workspaceId: string | undefined;
	query: string;
	includePattern: string;
	excludePattern: string;
	isRegex: boolean;
	caseSensitive: boolean;
	enabled?: boolean;
	limit?: number;
}

export function useContentSearch({
	workspaceId,
	query,
	includePattern,
	excludePattern,
	isRegex,
	caseSensitive,
	enabled = true,
	limit = DEFAULT_SEARCH_LIMIT,
}: UseContentSearchParams) {
	const trimmedQuery = query.trim();
	const validationError = useMemo(
		() => getSearchValidationError(trimmedQuery, isRegex),
		[trimmedQuery, isRegex],
	);
	const debouncedQuery = useDebouncedValue(trimmedQuery, 150);
	const isDebouncing =
		trimmedQuery.length > 0 && trimmedQuery !== debouncedQuery;

	const { data, isFetching } = electronTrpc.filesystem.searchContent.useQuery(
		{
			workspaceId: workspaceId ?? "",
			query: debouncedQuery,
			includeHidden: false,
			includePattern,
			excludePattern,
			limit,
			isRegex,
			caseSensitive,
		},
		{
			enabled:
				Boolean(workspaceId) &&
				enabled &&
				debouncedQuery.length > 0 &&
				validationError === null,
			staleTime: 1000,
			placeholderData: (previous) => previous ?? { matches: [] },
		},
	);

	const searchResults: SearchContentResult[] =
		validationError === null
			? (data?.matches.map((match) => ({
					id: `${match.absolutePath}:${match.line}:${match.column}`,
					absolutePath: match.absolutePath,
					relativePath: match.relativePath,
					name: match.absolutePath.split(/[/\\]/).pop() ?? match.absolutePath,
					line: match.line,
					column: match.column,
					preview: match.preview,
				})) ?? [])
			: [];

	return {
		searchResults,
		isFetching: validationError === null && (isFetching || isDebouncing),
		hasQuery: trimmedQuery.length > 0,
		validationError,
	};
}
