import { rejectTerminalSessionReady } from "../../../lib/terminal/session-readiness";
import { electronTrpcClient } from "../../../lib/trpc-client";
import * as v1TerminalCache from "../../../screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";

/**
 * Uses standalone tRPC client to avoid React hook dependencies
 */
export const killTerminalForPane = (paneId: string): void => {
	rejectTerminalSessionReady(
		paneId,
		new Error("Terminal pane was closed before the session became ready"),
	);
	electronTrpcClient.terminal.kill.mutate({ paneId }).catch((error) => {
		console.warn(`Failed to kill terminal for pane ${paneId}:`, error);
	});
};

/**
 * Release xterm/WebGL resources for a terminal pane.
 * Call this AFTER the pane has been removed from the store so that the React
 * component is already unmounted (or will unmount in the same batch) before
 * xterm is disposed. dispose() is idempotent — safe to call even if the
 * useTerminalLifecycle cleanup already ran.
 */
export const releaseTerminalCache = (paneId: string): void => {
	v1TerminalCache.dispose(paneId);
};
