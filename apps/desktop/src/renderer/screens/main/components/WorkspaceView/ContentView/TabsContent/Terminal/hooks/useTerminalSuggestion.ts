import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { ActiveSuggestionHandle } from "../helpers";

export interface UseTerminalSuggestionOptions {
	commandBufferRef: React.MutableRefObject<string>;
	enabled: boolean;
	onAcceptWrite: (data: string) => void;
}

export interface UseTerminalSuggestionReturn {
	displaySuggestions: string[];
	selectedIndex: number;
	prefix: string;
	activeSuggestionRef: React.MutableRefObject<ActiveSuggestionHandle | null>;
}

const EMPTY: string[] = [];
const POLL_MS = 150;
const FETCH_DEBOUNCE_MS = 80;

export function useTerminalSuggestion({
	commandBufferRef,
	enabled,
	onAcceptWrite,
}: UseTerminalSuggestionOptions): UseTerminalSuggestionReturn {
	const [historySuggestions, setHistorySuggestions] = useState<string[]>(EMPTY);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [trackedInput, setTrackedInput] = useState("");
	const activeSuggestionRef = useRef<ActiveSuggestionHandle | null>(null);

	// Refs to avoid stale closures
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const onAcceptWriteRef = useRef(onAcceptWrite);
	onAcceptWriteRef.current = onAcceptWrite;
	const lastPrefixRef = useRef("");
	const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Refs to read current state from callbacks without deps
	const historySuggestionsRef = useRef(historySuggestions);
	historySuggestionsRef.current = historySuggestions;
	const selectedIndexRef = useRef(selectedIndex);
	selectedIndexRef.current = selectedIndex;

	// Single stable effect — mount once
	useEffect(() => {
		const id = setInterval(() => {
			if (!enabledRef.current) {
				if (lastPrefixRef.current !== "") {
					lastPrefixRef.current = "";
					setTrackedInput("");
					setHistorySuggestions(EMPTY);
					setSelectedIndex(0);
				}
				return;
			}

			const current = commandBufferRef.current;
			if (current === lastPrefixRef.current) return;
			lastPrefixRef.current = current;
			setTrackedInput(current);

			if (fetchTimerRef.current) {
				clearTimeout(fetchTimerRef.current);
				fetchTimerRef.current = null;
			}

			if (current.length < 2) {
				setHistorySuggestions(EMPTY);
				setSelectedIndex(0);
				return;
			}

			const prefix = current;
			fetchTimerRef.current = setTimeout(async () => {
				fetchTimerRef.current = null;
				if (!enabledRef.current) return;
				try {
					const result = await electronTrpcClient.terminal.getSuggestions.query(
						{
							prefix,
						},
					);
					if (lastPrefixRef.current !== prefix) return;
					setHistorySuggestions(result.length > 0 ? result : EMPTY);
					setSelectedIndex(0);
				} catch {
					// ignore
				}
			}, FETCH_DEBOUNCE_MS);
		}, POLL_MS);

		return () => {
			clearInterval(id);
			if (fetchTimerRef.current) {
				clearTimeout(fetchTimerRef.current);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const displaySuggestions = historySuggestions;

	const selected = displaySuggestions[selectedIndex] ?? null;
	// Compute suffix for keyboard handler (→ key acceptance)
	const suffix =
		selected &&
		trackedInput &&
		selected.startsWith(trackedInput) &&
		selected !== trackedInput
			? selected.slice(trackedInput.length)
			: null;

	const dismiss = useCallback(() => {
		setHistorySuggestions(EMPTY);
		setSelectedIndex(0);
		lastPrefixRef.current = commandBufferRef.current;
	}, [commandBufferRef]);

	const accept = useCallback(() => {
		const idx = selectedIndexRef.current;
		const history = historySuggestionsRef.current;
		const item = history[idx];
		const currentInput = lastPrefixRef.current;
		if (item && currentInput && item.startsWith(currentInput)) {
			const suffix = item.slice(currentInput.length);
			if (suffix) {
				onAcceptWriteRef.current(suffix);
				commandBufferRef.current = item;
				lastPrefixRef.current = item;
			}
		}
		setHistorySuggestions(EMPTY);
		setSelectedIndex(0);
	}, [commandBufferRef]);

	const loadingMoreRef = useRef(false);

	const loadMore = useCallback(async () => {
		if (loadingMoreRef.current) return;
		const prefix = lastPrefixRef.current;
		if (!prefix || prefix.length < 2) return;
		const currentLen = historySuggestionsRef.current.length;
		loadingMoreRef.current = true;
		try {
			const more = await electronTrpcClient.terminal.getSuggestions.query({
				prefix,
				offset: currentLen,
			});
			if (lastPrefixRef.current !== prefix) return;
			if (more.length > 0) {
				setHistorySuggestions((prev) => [...prev, ...more]);
			}
		} catch {
			// ignore
		} finally {
			loadingMoreRef.current = false;
		}
	}, []);

	const selectNext = useCallback(() => {
		const len = displaySuggestions.length;
		if (len <= 1) return;
		setSelectedIndex((prev) => {
			const next = prev + 1;
			if (next >= len) {
				// At the end — try loading more
				void loadMore();
				return prev; // stay at last item while loading
			}
			return next;
		});
	}, [displaySuggestions.length, loadMore]);

	const selectPrev = useCallback(() => {
		const len = displaySuggestions.length;
		if (len <= 1) return;
		setSelectedIndex((prev) => (prev - 1 < 0 ? prev : prev - 1));
	}, [displaySuggestions.length]);

	// Sync ref — no state updates
	activeSuggestionRef.current =
		displaySuggestions.length > 0
			? {
					suffix,
					onAccept: accept,
					onDismiss: dismiss,
					selectNext,
					selectPrev,
					hasMultiple: displaySuggestions.length > 1,
				}
			: null;

	return {
		displaySuggestions,
		selectedIndex,
		prefix: trackedInput,
		activeSuggestionRef,
	};
}
