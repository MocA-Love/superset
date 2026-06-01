import { workspaceTrpc } from "@superset/workspace-client";
import { useCallback, useMemo, useState } from "react";
import { useDebouncedValue } from "renderer/hooks/useDebouncedValue";
import { getSearchValidationError } from "../../utils/searchPattern/searchPattern";
import { toSearchContentResult } from "../useContentSearch/useContentSearch";

const DEFAULT_SEARCH_LIMIT = 500;

interface UseWorkspaceContentSearchParams {
	workspaceId: string | undefined;
	query: string;
	includePattern: string;
	excludePattern: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
	enabled?: boolean;
	limit?: number;
}

export function useWorkspaceContentSearch({
	workspaceId,
	query,
	includePattern,
	excludePattern,
	isRegex,
	caseSensitive,
	wholeWord = false,
	multiline = false,
	enabled = true,
	limit = DEFAULT_SEARCH_LIMIT,
}: UseWorkspaceContentSearchParams) {
	const trimmedQuery = query.trim();
	const validationError = useMemo(
		() => getSearchValidationError(trimmedQuery, isRegex),
		[trimmedQuery, isRegex],
	);
	const debouncedQuery = useDebouncedValue(trimmedQuery, 150);
	const isDebouncing =
		trimmedQuery.length > 0 && trimmedQuery !== debouncedQuery;
	const [refreshEpoch, setRefreshEpoch] = useState(0);
	const refresh = useCallback(() => {
		setRefreshEpoch((current) => current + 1);
	}, []);

	const input = useMemo(
		() => ({
			workspaceId: workspaceId ?? "",
			query: debouncedQuery,
			includeHidden: false,
			includePattern,
			excludePattern,
			limit,
			isRegex,
			caseSensitive,
			wholeWord,
			multiline,
			scopeId: `search-tab:${refreshEpoch}`,
		}),
		[
			workspaceId,
			debouncedQuery,
			includePattern,
			excludePattern,
			limit,
			isRegex,
			caseSensitive,
			wholeWord,
			multiline,
			refreshEpoch,
		],
	);

	const queryEnabled =
		Boolean(workspaceId) &&
		enabled &&
		debouncedQuery.length > 0 &&
		validationError === null;
	const searchQuery = workspaceTrpc.filesystem.searchContent.useQuery(input, {
		enabled: queryEnabled,
		staleTime: 0,
		refetchOnWindowFocus: false,
	});

	const searchResults = useMemo(
		() =>
			validationError === null
				? (searchQuery.data?.matches.map(toSearchContentResult) ?? [])
				: [],
		[searchQuery.data?.matches, validationError],
	);

	return {
		searchResults,
		isFetching:
			validationError === null && (searchQuery.isFetching || isDebouncing),
		hasQuery: trimmedQuery.length > 0,
		validationError,
		refresh,
	};
}
