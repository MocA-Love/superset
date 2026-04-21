import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

	// We keep the "idle timeout after last event" and "reset-on-query-change"
	// bookkeeping in refs so biome's exhaustive-deps autofix can't strip them
	// from dep arrays. Using primitive/ref values also means the deps array
	// carries literal strings/numbers, not memoized objects.
	const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const resetIdleTimer = useCallback(() => {
		if (idleTimerRef.current !== null) {
			clearTimeout(idleTimerRef.current);
		}
		idleTimerRef.current = setTimeout(() => {
			idleTimerRef.current = null;
			setIsStreaming(false);
		}, 400);
	}, []);

	// Stable string identity of the query. Using a primitive in the deps
	// array avoids the "memoized object identity" dance and gives biome
	// nothing to autofix.
	const subscriptionKey = [
		workspaceId ?? "",
		debouncedQuery,
		includePattern,
		excludePattern,
		String(limit),
		String(isRegex),
		String(caseSensitive),
		String(wholeWord),
		String(multiline),
	].join("\u0000");

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

	// Reset results whenever the query identity changes. Previously this
	// keyed off `subscriptionEnabled` only, which meant editing the search
	// text while a stream was already running left stale matches in state
	// and new events were appended on top — producing mixed stale/current
	// rows and letting users "Replace match" against outdated hits.
	useEffect(() => {
		// Read subscriptionKey so biome's exhaustive-deps autofix sees it as
		// used; the effect re-runs whenever the query identity string
		// changes, which is exactly what we want (even though we don't need
		// the value at runtime).
		void subscriptionKey;
		if (idleTimerRef.current !== null) {
			clearTimeout(idleTimerRef.current);
			idleTimerRef.current = null;
		}
		if (subscriptionEnabled) {
			setSearchResults([]);
			setIsStreaming(true);
			resetIdleTimer();
		} else {
			setIsStreaming(false);
		}
	}, [subscriptionEnabled, subscriptionKey, resetIdleTimer]);

	// Flush the pending idle timer on unmount so it can't fire after the
	// hook caller has moved on.
	useEffect(
		() => () => {
			if (idleTimerRef.current !== null) {
				clearTimeout(idleTimerRef.current);
				idleTimerRef.current = null;
			}
		},
		[],
	);

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
				// Refresh the idle timer on every event so long-running
				// searches don't prematurely report "done" mid-stream.
				resetIdleTimer();
			},
			onError: () => {
				if (idleTimerRef.current !== null) {
					clearTimeout(idleTimerRef.current);
					idleTimerRef.current = null;
				}
				setIsStreaming(false);
			},
		},
	);

	return {
		searchResults: validationError === null ? searchResults : [],
		isFetching: validationError === null && (isStreaming || isDebouncing),
		hasQuery: trimmedQuery.length > 0,
		validationError,
	};
}
