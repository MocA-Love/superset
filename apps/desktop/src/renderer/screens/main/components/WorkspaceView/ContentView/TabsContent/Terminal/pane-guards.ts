import type { Pane } from "shared/tabs-types";

/**
 * Pane IDs that are being torn off to a new window.
 * While a pane is in this set, it should NOT be considered "destroyed"
 * even though it's been removed from the store. This prevents
 * useTerminalLifecycle from killing the terminal session during tearoff.
 */
export const tearoffPaneIds = new Set<string>();

export const isPaneDestroyed = (
	panes: Record<string, Pane> | undefined,
	paneId: string,
): boolean => {
	if (tearoffPaneIds.has(paneId)) return false;
	return !panes?.[paneId];
};
