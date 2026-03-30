import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { ActiveSuggestionHandle } from "../helpers";

export interface UseTerminalSuggestionOptions {
	commandBufferRef: React.MutableRefObject<string>;
	enabled: boolean;
	isAlternateScreenRef: React.MutableRefObject<boolean>;
	isAtPromptRef: React.MutableRefObject<boolean>;
	hasReceivedPromptMarkerRef: React.MutableRefObject<boolean>;
	xtermRef: React.MutableRefObject<XTerm | null>;
	onAcceptWrite: (data: string) => void;
}

export interface UseTerminalSuggestionReturn {
	displaySuggestions: string[];
	selectedIndex: number;
	prefix: string;
	activeSuggestionRef: React.MutableRefObject<ActiveSuggestionHandle | null>;
	deleteSuggestion: (cmd: string) => void;
}

const EMPTY: string[] = [];
const POLL_MS = 150;
const FETCH_DEBOUNCE_MS = 80;

/**
 * Read zsh-autosuggestions ghost text from the xterm buffer.
 * Ghost text appears after the cursor in dim or gray color.
 */
function readGhostText(xterm: XTerm): string {
	const buf = xterm.buffer.active;
	const lineIndex = buf.cursorY + buf.viewportY;
	const line = buf.getLine(lineIndex);
	if (!line) return "";

	let ghost = "";
	for (let x = buf.cursorX; x < line.length; x++) {
		const cell = line.getCell(x);
		if (!cell) break;
		const ch = cell.getChars();
		if (!ch) break;

		// zsh-autosuggestions uses dim attribute or gray palette/RGB colors
		if (cell.isDim() !== 0) {
			ghost += ch;
			continue;
		}
		if (cell.isFgPalette()) {
			const idx = cell.getFgColor();
			// 256-color palette grays (232-255) or bright black (8)
			if ((idx >= 232 && idx <= 255) || idx === 8) {
				ghost += ch;
				continue;
			}
		}
		if (cell.isFgRGB()) {
			const color = cell.getFgColor();
			const r = (color >> 16) & 0xff;
			const g = (color >> 8) & 0xff;
			const b = color & 0xff;
			// Grayscale: RGB values close together and dim
			if (
				Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(b - r)) < 30 &&
				r < 180
			) {
				ghost += ch;
				continue;
			}
		}
		break;
	}
	return ghost;
}

export function useTerminalSuggestion({
	commandBufferRef,
	enabled,
	isAlternateScreenRef,
	isAtPromptRef,
	hasReceivedPromptMarkerRef,
	xtermRef,
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
			const altRef = isAlternateScreenRef.current;
			// Only enforce prompt check if the shell has sent at least one marker
			const promptBlocked =
				hasReceivedPromptMarkerRef.current && !isAtPromptRef.current;

			if (!enabledRef.current || altRef || promptBlocked) {
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
				const promptBlocked2 =
					hasReceivedPromptMarkerRef.current && !isAtPromptRef.current;
				if (
					!enabledRef.current ||
					isAlternateScreenRef.current ||
					promptBlocked2
				)
					return;
				try {
					const result = await electronTrpcClient.terminal.getSuggestions.query(
						{
							prefix,
						},
					);
					if (lastPrefixRef.current !== prefix) return;
					// Re-check after async fetch
					if (hasReceivedPromptMarkerRef.current && !isAtPromptRef.current)
						return;

					// Read zsh-autosuggestions ghost text and prioritize it
					const xterm = xtermRef.current;
					if (xterm && result.length > 0) {
						const ghost = readGhostText(xterm);
						if (ghost) {
							const fullCmd = prefix + ghost;
							// Move ghost suggestion to front if it exists in results
							const filtered = result.filter((cmd) => cmd !== fullCmd);
							setHistorySuggestions([fullCmd, ...filtered]);
							setSelectedIndex(0);
							return;
						}
					}

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
	}, [
		commandBufferRef,
		isAlternateScreenRef,
		isAtPromptRef,
		hasReceivedPromptMarkerRef,
		xtermRef,
	]);

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
		deleteSuggestion,
	};
}
