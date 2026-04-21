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
	// Eagerly release xterm/WebGL resources in case the React unmount is delayed.
	// v1TerminalCache.dispose is idempotent (no-op if already disposed).
	v1TerminalCache.dispose(paneId);
	electronTrpcClient.terminal.kill.mutate({ paneId }).catch((error) => {
		console.warn(`Failed to kill terminal for pane ${paneId}:`, error);
	});
};
