import { useEffect, useMemo, useState } from "react";
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
	wholeWord?: boolean;
	multiline?: boolean;
	enabled?: boolean;
	limit?: number;
}

function toResult(match: {
	absolutePath: string;
	relativePath: string;
	line: number;
	column: number;
	preview: string;
}): SearchContentResult {
	return {
		id: `${match.absolutePath}:${match.line}:${match.column}`,
		absolutePath: match.absolutePath,
		relativePath: match.relativePath,
		name: match.absolutePath.split(/[/\\]/).pop() ?? match.absolutePath,
		line: match.line,
		column: match.column,
		preview: match.preview,
	};
}

export function useContentSearch({
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
}: UseContentSearchParams) {
	const trimmedQuery = query.trim();
	const validationError = useMemo(
		() => getSearchValidationError(trimmedQuery, isRegex),
		[trimmedQuery, isRegex],
	);
	const debouncedQuery = useDebouncedValue(trimmedQuery, 150);
	const isDebouncing =
		trimmedQuery.length > 0 && trimmedQuery !== debouncedQuery;

	// Incremental result set. We accumulate across emitted matches rather
	// than waiting for the subscription to complete, so the UI can render
	// hits as ripgrep finds them (VSCode-style streaming).
	const [searchResults, setSearchResults] = useState<SearchContentResult[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);

	// Reset state whenever any input that affects the query identity changes.
	// React Query's previous-data behavior would mask stale hits from a
	// different query, so we clear explicitly.
	useEffect(() => {
		setSearchResults([]);
		setIsStreaming(false);
	}, []);
	useEffect(() => {
		setSearchResults([]);
	}, []);

	const subscriptionInput = useMemo(
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
			scopeId: "search-tab",
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
		],
	);

	const subscriptionEnabled =
		Boolean(workspaceId) &&
		enabled &&
		debouncedQuery.length > 0 &&
		validationError === null;

	// Clear when the subscription re-subscribes with a new query identity.
	useEffect(() => {
		if (subscriptionEnabled) {
			setSearchResults([]);
			setIsStreaming(true);
		} else {
			setIsStreaming(false);
		}
	}, [subscriptionEnabled]);

	electronTrpc.filesystem.searchContentStream.useSubscription(
		subscriptionInput,
		{
			enabled: subscriptionEnabled,
			onData: (event) => {
				setSearchResults((prev) => {
					// Defensive dedupe: the server already drops repeats but
					// UI retries can cause overlaps in edge cases.
					const id = `${event.match.absolutePath}:${event.match.line}:${event.match.column}`;
					if (prev.some((r) => r.id === id)) return prev;
					return [...prev, toResult(event.match)];
				});
			},
			onError: () => {
				setIsStreaming(false);
			},
		},
	);

	// Subscription observables don't surface a completion hook from
	// trpc-electron, so the server emits `complete()` but the client just
	// ends the connection silently. Derive "done" from a short idle window
	// after the last data event.
	useEffect(() => {
		if (!isStreaming) return;
		const timer = setTimeout(() => setIsStreaming(false), 400);
		return () => clearTimeout(timer);
	}, [isStreaming]);

	return {
		searchResults: validationError === null ? searchResults : [],
		isFetching: validationError === null && (isStreaming || isDebouncing),
		hasQuery: trimmedQuery.length > 0,
		validationError,
	};
}
