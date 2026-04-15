import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { rejectTerminalSessionReady } from "renderer/lib/terminal/session-readiness";
import { electronTrpcClient as trpcClient } from "renderer/lib/trpc-client";
import { isTerminalAttachCanceledMessage } from "../attach-cancel";
import { coldRestoreState } from "../state";
import type {
	CreateOrAttachMutate,
	CreateOrAttachResult,
	TerminalCancelCreateOrAttachMutate,
	TerminalStreamEvent,
} from "../types";
import { scrollToBottom } from "../utils";
import * as v1TerminalCache from "../v1-terminal-cache";
import { createAttachRequestId } from "./attach-request-id";

export interface UseTerminalColdRestoreOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	xtermRef: React.MutableRefObject<XTerm | null>;
	isStreamReadyRef: React.MutableRefObject<boolean>;
	isExitedRef: React.MutableRefObject<boolean>;
	wasKilledByUserRef: React.MutableRefObject<boolean>;
	isFocusedRef: React.MutableRefObject<boolean>;
	didFirstRenderRef: React.MutableRefObject<boolean>;
	pendingInitialStateRef: React.MutableRefObject<CreateOrAttachResult | null>;
	pendingEventsRef: React.MutableRefObject<TerminalStreamEvent[]>;
	createOrAttachRef: React.MutableRefObject<CreateOrAttachMutate>;
	cancelCreateOrAttachRef: React.MutableRefObject<TerminalCancelCreateOrAttachMutate>;
	setConnectionError: (error: string | null) => void;
	setExitStatus: (status: "killed" | "exited" | null) => void;
	maybeApplyInitialState: () => void;
	flushPendingEvents: () => void;
	resetModes: () => void;
}

export interface UseTerminalColdRestoreReturn {
	isRestoredMode: boolean;
	restoredCwd: string | null;
	setIsRestoredMode: (value: boolean) => void;
	setRestoredCwd: (value: string | null) => void;
	handleRetryConnection: () => void;
	handleStartShell: () => void;
}

/**
 * Hook to manage cold restore (reboot recovery) functionality.
 *
 * Handles:
 * - Retry connection after daemon loss
 * - Starting new shell from restored scrollback
 * - Managing cold restore overlay state
 */
export function useTerminalColdRestore({
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
}: UseTerminalColdRestoreOptions): UseTerminalColdRestoreReturn {
	const [isRestoredMode, setIsRestoredMode] = useState(false);
	const [restoredCwd, setRestoredCwd] = useState<string | null>(null);

	// Ref for restoredCwd to use in callbacks
	const restoredCwdRef = useRef(restoredCwd);
	restoredCwdRef.current = restoredCwd;

	// FORK NOTE: Track the request id of any in-flight createOrAttach kicked
	// off from handleRetryConnection / handleStartShell so we can cancel it
	// when the pane unmounts (or the call is superseded by another retry).
	// Without this, closing a pane mid-reconnect or mid-cold-restore leaves
	// a daemon-side attach running to completion — potentially spawning an
	// orphan shell the user never sees, and leaking PTY + fd + memory.
	const activeRequestIdRef = useRef<string | null>(null);

	const cancelActiveRequest = useCallback(() => {
		const current = activeRequestIdRef.current;
		if (!current) return;
		activeRequestIdRef.current = null;
		cancelCreateOrAttachRef.current({ paneId, requestId: current });
	}, [paneId, cancelCreateOrAttachRef]);

	// Cancel any in-flight cold-restore attach on unmount so a rapid
	// pane close / component teardown does not leave a dangling attach.
	useEffect(() => cancelActiveRequest, [cancelActiveRequest]);

	const handleRetryConnection = useCallback(() => {
		setConnectionError(null);
		const xterm = xtermRef.current;
		if (!xterm) return;

		isStreamReadyRef.current = false;
		pendingInitialStateRef.current = null;

		// Supersede any previous in-flight cold-restore attach — no-op if none.
		cancelActiveRequest();
		const requestId = createAttachRequestId(paneId);
		activeRequestIdRef.current = requestId;

		createOrAttachRef.current(
			{
				paneId,
				requestId,
				tabId,
				workspaceId,
				cols: xterm.cols,
				rows: xterm.rows,
			},
			{
				onSuccess: (result: CreateOrAttachResult) => {
					if (activeRequestIdRef.current !== requestId) return;
					activeRequestIdRef.current = null;
					const currentXterm = xtermRef.current;
					if (!currentXterm) return;

					setConnectionError(null);
					currentXterm.writeln("\x1b[90m[Reconnected]\x1b[0m");

					if (result.isColdRestore) {
						const scrollback =
							result.snapshot?.snapshotAnsi ?? result.scrollback;
						coldRestoreState.set(paneId, {
							isRestored: true,
							cwd: result.previousCwd || null,
							scrollback,
						});
						setIsRestoredMode(true);
						setRestoredCwd(result.previousCwd || null);

						currentXterm.clear();
						if (scrollback) {
							currentXterm.write(scrollback, () => {
								requestAnimationFrame(() => {
									if (xtermRef.current !== currentXterm) return;
									scrollToBottom(currentXterm);
								});
							});
						}

						didFirstRenderRef.current = true;
						return;
					}

					pendingInitialStateRef.current = result;
					maybeApplyInitialState();

					if (isFocusedRef.current) {
						currentXterm.focus();
					}
				},
				onError: (error: { message?: string }) => {
					if (activeRequestIdRef.current !== requestId) return;
					activeRequestIdRef.current = null;
					if (isTerminalAttachCanceledMessage(error.message)) {
						return;
					}
					if (error.message?.includes("TERMINAL_SESSION_KILLED")) {
						wasKilledByUserRef.current = true;
						isExitedRef.current = true;
						isStreamReadyRef.current = false;
						setExitStatus("killed");
						setConnectionError(null);
						return;
					}
					setConnectionError(error.message || "Connection failed");
					isStreamReadyRef.current = true;
					flushPendingEvents();
				},
			},
		);
	}, [
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
		createOrAttachRef,
		cancelActiveRequest,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
	]);

	const handleStartShell = useCallback(() => {
		const xterm = xtermRef.current;
		if (!xterm) return;

		// Drop any queued events from the pre-restore session
		pendingEventsRef.current = [];

		// Acknowledge cold restore to main process
		trpcClient.terminal.ackColdRestore.mutate({ paneId }).catch((error) => {
			console.warn("[Terminal] Failed to acknowledge cold restore:", {
				paneId,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// Add visual separator
		xterm.write("\r\n\x1b[90m─── Session Contents Restored ───\x1b[0m\r\n\r\n");

		// Reset state for new session
		isStreamReadyRef.current = false;
		isExitedRef.current = false;
		wasKilledByUserRef.current = false;
		setExitStatus(null);
		pendingInitialStateRef.current = null;
		resetModes();

		// Supersede any previous cold-restore attach before spawning the
		// replacement shell — covers the case where handleStartShell is
		// re-invoked while an earlier attempt is still in flight.
		cancelActiveRequest();
		const requestId = createAttachRequestId(paneId);
		activeRequestIdRef.current = requestId;

		// Create new session with previous cwd
		createOrAttachRef.current(
			{
				paneId,
				requestId,
				tabId,
				workspaceId,
				cols: xterm.cols,
				rows: xterm.rows,
				cwd: restoredCwdRef.current || undefined,
				skipColdRestore: true,
				allowKilled: true,
			},
			{
				onSuccess: (result: CreateOrAttachResult) => {
					if (activeRequestIdRef.current !== requestId) return;
					activeRequestIdRef.current = null;
					pendingInitialStateRef.current = result;
					maybeApplyInitialState();

					// FORK NOTE: now that handleStartShell has a real backend
					// session, mark the v1 cache + session-readiness waiters as
					// ready. useTerminalLifecycle.ts intentionally defers this
					// for the cold-restore path so that a tab-switch remount
					// does not take the isReattach fast-path before a real
					// shell exists.
					v1TerminalCache.markSessionReady(paneId);

					setIsRestoredMode(false);
					coldRestoreState.delete(paneId);

					setTimeout(() => {
						const currentXterm = xtermRef.current;
						if (currentXterm) {
							currentXterm.focus();
						}
					}, 0);
				},
				onError: (error: { message?: string }) => {
					if (activeRequestIdRef.current !== requestId) return;
					activeRequestIdRef.current = null;
					if (isTerminalAttachCanceledMessage(error.message)) {
						return;
					}
					console.error("[Terminal] Failed to start shell:", error);
					setConnectionError(error.message || "Failed to start shell");
					setIsRestoredMode(false);
					coldRestoreState.delete(paneId);
					rejectTerminalSessionReady(
						paneId,
						new Error(error.message || "Failed to start shell"),
					);
					isStreamReadyRef.current = true;
					flushPendingEvents();
				},
			},
		);
	}, [
		paneId,
		tabId,
		workspaceId,
		xtermRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		pendingInitialStateRef,
		pendingEventsRef,
		createOrAttachRef,
		cancelActiveRequest,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
	]);

	return {
		isRestoredMode,
		restoredCwd,
		setIsRestoredMode,
		setRestoredCwd,
		handleRetryConnection,
		handleStartShell,
	};
}
