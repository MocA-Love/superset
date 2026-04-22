import { useRef, useState } from "react";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { logTerminalInput, terminalRendererDebug } from "../debug";
import { DEBUG_TERMINAL } from "../config";
import type {
	TerminalCancelCreateOrAttachMutate,
	TerminalClearScrollbackMutate,
	TerminalDetachMutate,
	TerminalResizeMutate,
	TerminalWriteMutate,
} from "../types";

export interface UseTerminalConnectionOptions {
	workspaceId: string;
}

const FLOW_DEBUG_PANE_ID_KEY = "SUPERSET_TERMINAL_DEBUG_PANE_ID";

function readDebugPaneId(): string | null {
	try {
		return window.localStorage.getItem(FLOW_DEBUG_PANE_ID_KEY);
	} catch {
		return null;
	}
}

function shouldLogPaneDebug(paneId: string): boolean {
	if (!DEBUG_TERMINAL) return false;
	const value = readDebugPaneId();
	return value === "*" || value === paneId;
}

function utf8Hex(data: string): string {
	return Array.from(new TextEncoder().encode(data))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join(" ");
}

function summarizeTerminalInput(data: string): Record<string, unknown> {
	return {
		bytes: new TextEncoder().encode(data).length,
		chars: data.length,
		escapes: (data.match(/\x1b/g) || []).length,
		cprResponse: /\x1b\[[0-9]+;[0-9]+R/.test(data),
		focusIn: data.includes("\x1b[I"),
		focusOut: data.includes("\x1b[O"),
		kittyKeyboard: /\x1b\[[0-9;:]+u/.test(data),
		bracketedPasteStart: data.includes("\x1b[200~"),
		bracketedPasteEnd: data.includes("\x1b[201~"),
		preview:
			JSON.stringify(data).length > 220
				? `${JSON.stringify(data).slice(0, 220)}…`
				: JSON.stringify(data),
	};
}

function isInterestingTerminalInput(data: string): boolean {
	return (
		/\x1b\[[0-9]+;[0-9]+R/.test(data) ||
		data.includes("\x1b[I") ||
		data.includes("\x1b[O") ||
		/\x1b\[[0-9;:]+u/.test(data) ||
		data.includes("\x1b[200~") ||
		data.includes("\x1b[201~")
	);
}

/**
 * Hook to manage terminal connection state and mutations.
 *
 * Encapsulates:
 * - createOrAttach mutation (for lifecycle callbacks)
 * - imperative tRPC calls for write/resize/detach/clearScrollback hot paths
 * - Stable refs to mutation functions (to avoid re-renders)
 * - Connection error state
 * - Workspace CWD query
 *
 * NOTE: Stream subscription is intentionally NOT included here because it needs
 * direct access to xterm refs for event handling. Keep that in the component.
 */
export function useTerminalConnection({
	workspaceId,
}: UseTerminalConnectionOptions) {
	const [connectionError, setConnectionError] = useState<string | null>(null);

	// tRPC mutations
	const createOrAttachMutation = useCreateOrAttachWithTheme();

	// Query for workspace cwd
	const { data: workspaceCwd } =
		electronTrpc.terminal.getWorkspaceCwd.useQuery(workspaceId);

	// Stable refs - these don't change identity on re-render
	const createOrAttachRef = useRef(createOrAttachMutation.mutate);
	// Use imperative client calls for write/resize/detach/clear to avoid
	// mutation-observer re-renders on every keystroke.
	const writeRef = useRef<TerminalWriteMutate>((input, callbacks) => {
		if (
			shouldLogPaneDebug(input.paneId) &&
			isInterestingTerminalInput(input.data)
		) {
			console.log(`[terminal-write][pane=${input.paneId}] renderer-to-pty`, {
				summary: summarizeTerminalInput(input.data),
				hex: utf8Hex(input.data),
			});
		}
		logTerminalInput("trpc-write", input.data.length, { paneId: input.paneId });
		electronTrpcClient.terminal.write
			.mutate(input)
			.then(() => {
				callbacks?.onSuccess?.();
			})
			.catch((error) => {
				terminalRendererDebug.error(
					"terminal-write-mutate-failed",
					{
						paneId: input.paneId,
						bytes: input.data.length,
						errorMessage:
							error instanceof Error ? error.message : "Write failed",
					},
					{
						captureMessage: true,
						fingerprint: ["terminal.renderer", "terminal-write-mutate-failed"],
					},
				);
				callbacks?.onError?.({
					message: error instanceof Error ? error.message : "Write failed",
				});
			})
			.finally(() => {
				callbacks?.onSettled?.();
			});
	});
	// ResizeObserver 側で確定したサイズを受けて、即座に PTY に通知する。
	const resizeRef = useRef<TerminalResizeMutate>((input) => {
		if (DEBUG_TERMINAL) {
			console.log(`[resize:mutate] pane=${input.paneId} ${input.cols}x${input.rows}`);
		}
		electronTrpcClient.terminal.resize.mutate(input).catch((error) => {
			console.warn("[Terminal] Failed to resize terminal:", error);
		});
	});
	const detachRef = useRef<TerminalDetachMutate>((input) => {
		electronTrpcClient.terminal.detach.mutate(input).catch((error) => {
			console.warn("[Terminal] Failed to detach terminal:", error);
		});
	});
	const cancelCreateOrAttachRef = useRef<TerminalCancelCreateOrAttachMutate>(
		(input) => {
			electronTrpcClient.terminal.cancelCreateOrAttach
				.mutate(input)
				.catch((error) => {
					console.warn("[Terminal] Failed to cancel create/attach:", error);
				});
		},
	);
	const clearScrollbackRef = useRef<TerminalClearScrollbackMutate>((input) => {
		electronTrpcClient.terminal.clearScrollback.mutate(input).catch((error) => {
			console.warn("[Terminal] Failed to clear scrollback:", error);
		});
	});

	// Keep refs up to date
	createOrAttachRef.current = createOrAttachMutation.mutate;

	return {
		// Connection error state
		connectionError,
		setConnectionError,

		// Workspace CWD from query
		workspaceCwd,

		// Stable refs to mutation functions (use these in effects/callbacks)
		refs: {
			createOrAttach: createOrAttachRef,
			write: writeRef,
			resize: resizeRef,
			detach: detachRef,
			cancelCreateOrAttach: cancelCreateOrAttachRef,
			clearScrollback: clearScrollbackRef,
		},
	};
}
