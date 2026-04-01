import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { ActiveSuggestionHandle } from "../helpers";

export interface UseTerminalSuggestionOptions {
	commandBufferRef: React.MutableRefObject<string>;
	enabled: boolean;
	isAlternateScreenRef: React.MutableRefObject<boolean>;
	isAtPromptRef: React.MutableRefObject<boolean>;
	hasReceivedPromptMarkerRef: React.MutableRefObject<boolean>;
	onAcceptWrite: (data: string) => void;
	onExecuteCommand: (command: string, currentInput: string) => void;
}

export interface UseTerminalSuggestionReturn {
	displaySuggestions: string[];
	selectedIndex: number;
	prefix: string;
	activeSuggestionRef: React.MutableRefObject<ActiveSuggestionHandle | null>;
	deleteSuggestion: (cmd: string) => void;
	openHistorySuggestions: () => void;
}

const EMPTY: string[] = [];
const POLL_MS = 150;
const FETCH_DEBOUNCE_MS = 80;

export function useTerminalSuggestion({
	commandBufferRef,
	enabled,
	isAlternateScreenRef,
	isAtPromptRef,
	hasReceivedPromptMarkerRef,
	onAcceptWrite,
	onExecuteCommand,
}: UseTerminalSuggestionOptions): UseTerminalSuggestionReturn {
	const [historySuggestions, setHistorySuggestions] = useState<string[]>(EMPTY);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [trackedInput, setTrackedInput] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	const activeSuggestionRef = useRef<ActiveSuggestionHandle | null>(null);

	// Refs to avoid stale closures
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const onAcceptWriteRef = useRef(onAcceptWrite);
	onAcceptWriteRef.current = onAcceptWrite;
	const onExecuteCommandRef = useRef(onExecuteCommand);
	onExecuteCommandRef.current = onExecuteCommand;
	const lastPrefixRef = useRef("");
	const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isOpenRef = useRef(isOpen);
	isOpenRef.current = isOpen;

	// Refs to read current state from callbacks without deps
	const historySuggestionsRef = useRef(historySuggestions);
	historySuggestionsRef.current = historySuggestions;
	const selectedIndexRef = useRef(selectedIndex);
	selectedIndexRef.current = selectedIndex;

	const dismiss = useCallback(() => {
		setIsOpen(false);
		setTrackedInput("");
		setHistorySuggestions(EMPTY);
		setSelectedIndex(0);
		lastPrefixRef.current = commandBufferRef.current;
		if (fetchTimerRef.current) {
			clearTimeout(fetchTimerRef.current);
			fetchTimerRef.current = null;
		}
	}, [commandBufferRef]);

	const fetchSuggestions = useCallback(
		async (prefix: string, offset = 0, append = false) => {
			const promptBlocked =
				hasReceivedPromptMarkerRef.current && !isAtPromptRef.current;
			if (
				!enabledRef.current ||
				isAlternateScreenRef.current ||
				promptBlocked ||
				!isOpenRef.current
			) {
				return;
			}

			try {
				const result = await electronTrpcClient.terminal.getSuggestions.query({
					prefix,
					offset,
				});
				if (!isOpenRef.current || lastPrefixRef.current !== prefix) return;

				if (append) {
					if (result.length > 0) {
						setHistorySuggestions((prev) => [...prev, ...result]);
					}
					return;
				}

				setHistorySuggestions(result.length > 0 ? result : EMPTY);
				setSelectedIndex(0);
			} catch {
				// ignore
			}
		},
		[hasReceivedPromptMarkerRef, isAlternateScreenRef, isAtPromptRef],
	);

	const openHistorySuggestions = useCallback(() => {
		const promptBlocked =
			hasReceivedPromptMarkerRef.current && !isAtPromptRef.current;
		if (
			!enabledRef.current ||
			isAlternateScreenRef.current ||
			promptBlocked
		) {
			return;
		}

		const prefix = commandBufferRef.current;
		isOpenRef.current = true;
		setIsOpen(true);
		setTrackedInput(prefix);
		lastPrefixRef.current = prefix;

		if (fetchTimerRef.current) {
			clearTimeout(fetchTimerRef.current);
			fetchTimerRef.current = null;
		}

		void fetchSuggestions(prefix);
	}, [
		commandBufferRef,
		fetchSuggestions,
		hasReceivedPromptMarkerRef,
		isAlternateScreenRef,
		isAtPromptRef,
	]);

	useEffect(() => {
		const promptBlocked =
			hasReceivedPromptMarkerRef.current && !isAtPromptRef.current;
		if (!enabled || isAlternateScreenRef.current || promptBlocked) {
			dismiss();
		}
	}, [
		dismiss,
		enabled,
		hasReceivedPromptMarkerRef,
		isAlternateScreenRef,
		isAtPromptRef,
	]);

	useEffect(() => {
		if (!isOpen) return;

		const id = setInterval(() => {
			const current = commandBufferRef.current;
			if (current === lastPrefixRef.current) return;
			lastPrefixRef.current = current;
			setTrackedInput(current);

			if (fetchTimerRef.current) {
				clearTimeout(fetchTimerRef.current);
			}

			fetchTimerRef.current = setTimeout(() => {
				fetchTimerRef.current = null;
				void fetchSuggestions(current);
			}, FETCH_DEBOUNCE_MS);
		}, POLL_MS);

		return () => {
			clearInterval(id);
			if (fetchTimerRef.current) {
				clearTimeout(fetchTimerRef.current);
				fetchTimerRef.current = null;
			}
		};
	}, [commandBufferRef, fetchSuggestions, isOpen]);

	const displaySuggestions = historySuggestions;

	const selected = displaySuggestions[selectedIndex] ?? null;
	const suffix =
		selected &&
		selected.startsWith(trackedInput) &&
		selected !== trackedInput
			? selected.slice(trackedInput.length)
			: null;

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

	const execute = useCallback(() => {
		const idx = selectedIndexRef.current;
		const history = historySuggestionsRef.current;
		const item = history[idx];
		const currentInput = lastPrefixRef.current;
		if (!item) {
			dismiss();
			return;
		}

		onExecuteCommandRef.current(item, currentInput);
		setIsOpen(false);
		setTrackedInput("");
		setHistorySuggestions(EMPTY);
		setSelectedIndex(0);
		lastPrefixRef.current = "";
	}, [dismiss]);

	const loadingMoreRef = useRef(false);

	const loadMore = useCallback(async () => {
		if (loadingMoreRef.current) return;
		const prefix = lastPrefixRef.current;
		const currentLen = historySuggestionsRef.current.length;
		loadingMoreRef.current = true;
		try {
			await fetchSuggestions(prefix, currentLen, true);
		} catch {
			// ignore
		} finally {
			loadingMoreRef.current = false;
		}
	}, [fetchSuggestions]);

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

	const deleteSuggestion = useCallback((cmd: string) => {
		// Remove from UI immediately
		setHistorySuggestions((prev) => prev.filter((item) => item !== cmd));
		setSelectedIndex(0);
		// Delete from history file in background
		void electronTrpcClient.terminal.deleteHistorySuggestion
			.mutate({ command: cmd })
			.catch(() => {});
	}, []);

	// Sync ref — no state updates
	activeSuggestionRef.current =
		displaySuggestions.length > 0
			? {
					suffix,
					onAccept: accept,
					onExecute: execute,
					onDismiss: dismiss,
					selectNext,
					selectPrev,
					hasSuggestions: true,
				}
			: null;

	return {
		displaySuggestions,
		selectedIndex,
		prefix: trackedInput,
		activeSuggestionRef,
		deleteSuggestion,
		openHistorySuggestions,
	};
}
