import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { buildTerminalCommand } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTerminalSuggestionsStore } from "renderer/stores/terminal-suggestions";
import { useTerminalTheme } from "renderer/stores/theme";
import { sanitizeForTitle } from "./commandBuffer";
import { SessionKilledOverlay } from "./components";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "./config";
import { getDefaultTerminalBg } from "./helpers";
import {
	useFileLinkClick,
	useTerminalColdRestore,
	useTerminalConnection,
	useTerminalCwd,
	useTerminalHotkeys,
	useTerminalLifecycle,
	useTerminalModes,
	useTerminalRefs,
	useTerminalRestore,
	useTerminalStream,
	useTerminalSuggestion,
} from "./hooks";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { TerminalSearch } from "./TerminalSearch";
import { TerminalSuggestion } from "./TerminalSuggestion";
import { TerminalTypingPreview } from "./TerminalTypingPreview";
import type {
	TerminalExitReason,
	TerminalProps,
	TerminalStreamEvent,
} from "./types";
import { shellEscapePaths } from "./utils";
import * as v1TerminalCache from "./v1-terminal-cache";

const stripLeadingEmoji = (text: string) =>
	text.trim().replace(/^[\p{Emoji}\p{Symbol}]\s*/u, "");
const TYPING_PREVIEW_MAX_DURATION_MS = 200;

export const Terminal = memo(function Terminal({
	paneId,
	tabId,
	workspaceId,
}: TerminalProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const isWorkspaceRunPane = Boolean(pane?.workspaceRun?.workspaceId);
	const paneInitialCwd = pane?.initialCwd;
	const clearPaneInitialData = useTabsStore((s) => s.clearPaneInitialData);

	const { data: workspaceData } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ staleTime: 30_000 },
	);
	const isUnnamedRef = useRef(false);
	isUnnamedRef.current = workspaceData?.isUnnamed ?? false;

	const { data: workspaceRunConfig } =
		electronTrpc.workspaces.getResolvedRunCommands.useQuery(
			{ workspaceId },
			{ enabled: isWorkspaceRunPane },
		);

	const workspaceRunRestartCommand = isWorkspaceRunPane
		? buildTerminalCommand(workspaceRunConfig?.commands)
		: null;
	const defaultRestartCommandRef = useRef<string | undefined>(undefined);
	defaultRestartCommandRef.current =
		workspaceRunRestartCommand ?? pane?.workspaceRun?.command;

	const utils = electronTrpc.useUtils();
	const updateWorkspace = electronTrpc.workspaces.update.useMutation({
		onSuccess: () => {
			utils.workspaces.getAllGrouped.invalidate();
			utils.workspaces.get.invalidate({ id: workspaceId });
		},
	});

	const renameUnnamedWorkspaceRef = useRef<(title: string) => void>(() => {});
	renameUnnamedWorkspaceRef.current = (title: string) => {
		const cleanedTitle = stripLeadingEmoji(title);
		if (isUnnamedRef.current && cleanedTitle) {
			updateWorkspace.mutate({
				id: workspaceId,
				patch: { name: cleanedTitle, preserveUnnamedStatus: true },
			});
		}
	};
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const isExitedRef = useRef(false);
	const [exitStatus, setExitStatus] = useState<"killed" | "exited" | null>(
		null,
	);
	const [typingPreviewText, setTypingPreviewText] = useState("");
	const wasKilledByUserRef = useRef(false);
	const typingPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const pendingEventsRef = useRef<TerminalStreamEvent[]>([]);
	const commandBufferRef = useRef("");
	const tabIdRef = useRef(tabId);
	tabIdRef.current = tabId;
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const setPaneName = useTabsStore((s) => s.setPaneName);
	const focusedPaneId = useTabsStore((s) => s.focusedPaneIds[tabId]);
	const terminalTheme = useTerminalTheme();

	// Terminal connection state and mutations
	const {
		connectionError,
		setConnectionError,
		workspaceCwd,
		refs: {
			createOrAttach: createOrAttachRef,
			write: writeRef,
			resize: resizeRef,
			cancelCreateOrAttach: cancelCreateOrAttachRef,
			clearScrollback: clearScrollbackRef,
		},
	} = useTerminalConnection({ workspaceId });

	// Terminal CWD management
	const { updateCwdFromData } = useTerminalCwd({
		paneId,
		initialCwd: paneInitialCwd,
		workspaceCwd,
	});

	// Terminal modes tracking
	const {
		isAlternateScreenRef,
		isBracketedPasteRef,
		isAtPromptRef,
		hasReceivedPromptMarkerRef,
		modeScanBufferRef,
		updateModesFromData,
		resetModes,
	} = useTerminalModes();

	// File link click handler
	const { handleFileLinkClick } = useFileLinkClick({
		workspaceId,
		projectId: workspaceData?.projectId,
	});

	// URL click handler - opens in app browser or system browser based on setting
	const { data: openLinksInApp } =
		electronTrpc.settings.getOpenLinksInApp.useQuery();
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const handleUrlClickRef = useRef<((url: string) => void) | undefined>(
		undefined,
	);
	handleUrlClickRef.current = openLinksInApp
		? (url: string) => openInBrowserPane(workspaceId, url)
		: undefined;

	// Refs for stream event handlers (populated after useTerminalStream)
	// These allow flushPendingEvents to call the handlers via refs
	const handleTerminalExitRef = useRef<
		(exitCode: number, xterm: XTerm, reason?: TerminalExitReason) => void
	>(() => {});
	const handleStreamErrorRef = useRef<
		(
			event: Extract<TerminalStreamEvent, { type: "error" }>,
			xterm: XTerm,
		) => void
	>(() => {});

	const {
		isFocused,
		isFocusedRef,
		initialThemeRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		handleFileLinkClickRef,
		setPaneNameRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
	} = useTerminalRefs({
		paneId,
		tabId,
		focusedPaneId,
		terminalTheme,
		paneInitialCwd,
		clearPaneInitialData,
		handleFileLinkClick,
		setPaneName,
		setFocusedPane,
	});

	// Terminal restore logic
	const {
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
	} = useTerminalRestore({
		paneId,
		xtermRef,
		fitAddonRef,
		pendingEventsRef,
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		updateCwdFromData,
		updateModesFromData,
		onExitEvent: (exitCode, xterm, reason) =>
			handleTerminalExitRef.current(exitCode, xterm, reason),
		onErrorEvent: (event, xterm) => handleStreamErrorRef.current(event, xterm),
		onDisconnectEvent: (reason) =>
			setConnectionError(reason || "Connection to terminal daemon lost"),
	});

	// Cold restore handling
	const {
		isRestoredMode,
		setIsRestoredMode,
		setRestoredCwd,
		handleRetryConnection,
		handleStartShell,
	} = useTerminalColdRestore({
		paneId,
		tabId,
		workspaceId,
		xtermRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		isFocusedRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		pendingEventsRef,
		createOrAttachRef,
		cancelCreateOrAttachRef,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
	});

	// Avoid effect re-runs: track overlay states via refs for input gating
	const isRestoredModeRef = useRef(isRestoredMode);
	isRestoredModeRef.current = isRestoredMode;
	const connectionErrorRef = useRef(connectionError);
	connectionErrorRef.current = connectionError;

	// Auto-retry connection with exponential backoff
	const retryCountRef = useRef(0);
	const MAX_RETRIES = 5;

	// Stream handling
	const { handleTerminalExit, handleStreamError, handleStreamData } =
		useTerminalStream({
			paneId,
			xtermRef,
			isStreamReadyRef,
			isExitedRef,
			wasKilledByUserRef,
			pendingEventsRef,
			setExitStatus,
			setConnectionError,
			updateModesFromData,
			updateCwdFromData,
		});

	// Populate handler refs for flushPendingEvents to use
	handleTerminalExitRef.current = handleTerminalExit;
	handleStreamErrorRef.current = handleStreamError;

	// Auto-retry when connection error is set
	useEffect(() => {
		if (!connectionError) return;
		if (isExitedRef.current) return;
		if (retryCountRef.current >= MAX_RETRIES) return;

		if (retryCountRef.current === 0) {
			xtermRef.current?.writeln(
				"\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m",
			);
		}

		const delay = Math.min(1000 * 2 ** retryCountRef.current, 10_000);
		retryCountRef.current++;

		const timeout = setTimeout(handleRetryConnection, delay);
		return () => clearTimeout(timeout);
	}, [connectionError, handleRetryConnection]);

	const { isSearchOpen, setIsSearchOpen } = useTerminalHotkeys({
		isFocused,
		xtermRef,
	});

	// Shell history suggestions
	const suggestionsEnabled = useTerminalSuggestionsStore((s) => s.enabled);
	const handleSuggestionWrite = useCallback(
		(data: string) => {
			if (!isExitedRef.current) {
				writeRef.current({ paneId, data });
			}
		},
		[paneId, writeRef],
	);
	const handleSuggestionExecute = useCallback(
		(command: string, currentInput: string) => {
			if (isExitedRef.current) return;

			const title = sanitizeForTitle(command);
			if (title) {
				setPaneName(paneId, title);
				renameUnnamedWorkspaceRef.current(title);
			}

			const data = command.startsWith(currentInput)
				? `${command.slice(currentInput.length)}\r`
				: `\x15${command}\r`;
			const suffix = command.startsWith(currentInput)
				? command.slice(currentInput.length)
				: "";

			if (typingPreviewTimeoutRef.current) {
				clearTimeout(typingPreviewTimeoutRef.current);
				typingPreviewTimeoutRef.current = null;
			}

			if (!suffix) {
				setTypingPreviewText("");
				writeRef.current({ paneId, data });
				commandBufferRef.current = "";
				isAtPromptRef.current = false;
				return;
			}

			const totalSteps = suffix.length;
			const durationMs = Math.max(0, TYPING_PREVIEW_MAX_DURATION_MS);

			if (durationMs === 0) {
				setTypingPreviewText("");
				writeRef.current({ paneId, data });
				commandBufferRef.current = "";
				isAtPromptRef.current = false;
				return;
			}

			const startTime = performance.now();

			const finish = () => {
				setTypingPreviewText("");
				typingPreviewTimeoutRef.current = null;
				writeRef.current({ paneId, data });
				commandBufferRef.current = "";
				isAtPromptRef.current = false;
			};

			const tick = () => {
				const elapsed = performance.now() - startTime;
				const progress = Math.min(1, elapsed / durationMs);
				const visibleLength = Math.max(
					1,
					Math.min(totalSteps, Math.ceil(progress * totalSteps)),
				);
				setTypingPreviewText(suffix.slice(0, visibleLength));

				if (progress >= 1) {
					finish();
					return;
				}

				typingPreviewTimeoutRef.current = setTimeout(tick, 0);
			};

			setTypingPreviewText(suffix.slice(0, 1));
			typingPreviewTimeoutRef.current = setTimeout(tick, 0);
		},
		[paneId, setPaneName, writeRef, isAtPromptRef],
	);
	const {
		displaySuggestions,
		selectedIndex,
		prefix: suggestionPrefix,
		activeSuggestionRef,
		deleteSuggestion,
		canOpenHistorySuggestions,
		openHistorySuggestions,
	} = useTerminalSuggestion({
		commandBufferRef,
		enabled:
			suggestionsEnabled &&
			!isRestoredMode &&
			!connectionError &&
			!exitStatus &&
			!isWorkspaceRunPane,
		isAlternateScreenRef,
		isAtPromptRef,
		hasReceivedPromptMarkerRef,
		onAcceptWrite: handleSuggestionWrite,
		onExecuteCommand: handleSuggestionExecute,
	});
	const canOpenHistorySuggestionsRef = useRef(canOpenHistorySuggestions);
	canOpenHistorySuggestionsRef.current = canOpenHistorySuggestions;
	const openHistorySuggestionsRef = useRef(openHistorySuggestions);
	openHistorySuggestionsRef.current = openHistorySuggestions;

	useEffect(() => {
		if (!isRestoredMode) return;
		handleStartShell();
	}, [isRestoredMode, handleStartShell]);
	const { xtermInstance, restartTerminal } = useTerminalLifecycle({
		paneId,
		tabIdRef,
		workspaceId,
		terminalRef,
		xtermRef,
		fitAddonRef,
		searchAddonRef,
		isExitedRef,
		wasKilledByUserRef,
		commandBufferRef,
		isFocusedRef,
		isRestoredModeRef,
		connectionErrorRef,
		initialThemeRef,
		handleFileLinkClickRef,
		handleUrlClickRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		setConnectionError,
		setExitStatus,
		setIsRestoredMode,
		setRestoredCwd,
		createOrAttachRef,
		writeRef,
		resizeRef,
		cancelCreateOrAttachRef,
		clearScrollbackRef,
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
		isAlternateScreenRef,
		isBracketedPasteRef,
		setPaneNameRef,
		renameUnnamedWorkspaceRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
		defaultRestartCommandRef,
		activeSuggestionRef,
		canOpenHistorySuggestionsRef,
		openHistorySuggestionsRef,
	});

	// Stream event handler registration — the subscription itself lives in
	// v1TerminalCache and stays alive across mount/unmount cycles so data
	// keeps flowing to xterm even while the tab is hidden.
	// Placed after useTerminalLifecycle so the cache entry exists on cold mount.
	// Gated on xtermInstance so it re-runs once the lifecycle hook creates it.
	useEffect(() => {
		if (!xtermInstance) return;

		const queuedEvents = v1TerminalCache.registerHandlers(paneId, {
			onEvent: (event) => {
				if (connectionErrorRef.current && event.type === "data") {
					setConnectionError(null);
					retryCountRef.current = 0;
				}
				handleStreamData(event);
			},
			onError: (error) => {
				console.error("[Terminal] Stream subscription error:", {
					paneId,
					error: error instanceof Error ? error.message : String(error),
				});
				setConnectionError(
					error instanceof Error
						? error.message
						: "Connection to terminal lost",
				);
			},
		});

		// Process lifecycle events (exit, error, disconnect) that arrived
		// while this component was unmounted.
		for (const event of queuedEvents) {
			handleStreamData(event);
		}

		return () => {
			v1TerminalCache.unregisterHandlers(paneId);
		};
	}, [paneId, xtermInstance, handleStreamData, setConnectionError]);

	useEffect(() => {
		const xterm = xtermRef.current;
		if (!xterm || !terminalTheme) return;
		xterm.options.theme = terminalTheme;
	}, [terminalTheme]);

	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{
			staleTime: 30_000,
		},
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resizeRef is a stable MutableRefObject — .current is read inside the effect, not a dependency
	useEffect(() => {
		if (!fontSettings) return;
		const family =
			fontSettings.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
		const size = fontSettings.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
		const result = v1TerminalCache.updateAppearance(paneId, family, size);
		if (result?.changed) {
			resizeRef.current({ paneId, cols: result.cols, rows: result.rows });
		}
	}, [paneId, fontSettings]);

	useEffect(() => {
		return () => {
			if (typingPreviewTimeoutRef.current) {
				clearTimeout(typingPreviewTimeoutRef.current);
			}
		};
	}, []);

	const terminalBg = terminalTheme?.background ?? getDefaultTerminalBg();

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const files = Array.from(event.dataTransfer.files);
		let text: string;
		if (files.length > 0) {
			// Native file drop (from Finder, etc.)
			const paths = files.map((file) => window.webUtils.getPathForFile(file));
			text = shellEscapePaths(paths);
		} else {
			// Internal drag (from file tree) - path is in text/plain
			const plainText = event.dataTransfer.getData("text/plain");
			if (!plainText) return;
			text = shellEscapePaths([plainText]);
		}
		if (!isExitedRef.current) {
			writeRef.current({ paneId, data: text });
		}
	};

	return (
		<div
			role="application"
			className="relative h-full w-full overflow-hidden"
			style={{ backgroundColor: terminalBg }}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		>
			<TerminalSearch
				searchAddon={searchAddonRef.current}
				isOpen={isSearchOpen}
				onClose={() => setIsSearchOpen(false)}
			/>
			<ScrollToBottomButton terminal={xtermInstance} />
			{exitStatus === "killed" &&
				!connectionError &&
				!isRestoredMode &&
				!isWorkspaceRunPane && (
					<SessionKilledOverlay onRestart={restartTerminal} />
				)}
			<div className="h-full w-full p-2">
				<div ref={terminalRef} className="h-full w-full" />
			</div>
			{xtermInstance && typingPreviewText && (
				<TerminalTypingPreview xterm={xtermInstance} text={typingPreviewText} />
			)}
			{xtermInstance && displaySuggestions.length > 0 && (
				<TerminalSuggestion
					xterm={xtermInstance}
					suggestions={displaySuggestions}
					selectedIndex={selectedIndex}
					prefix={suggestionPrefix}
					onDelete={deleteSuggestion}
				/>
			)}
		</div>
	);
});
