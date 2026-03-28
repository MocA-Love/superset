import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * Global handler for new-window events from any browser pane.
 *
 * This must be mounted in a component that is **always rendered** (e.g. the
 * dashboard layout) because webviews persist in a hidden container even when
 * their BrowserPane component is unmounted. Without a persistent listener,
 * target="_blank" clicks in hidden webviews would be silently lost.
 */
export function useBrowserNewWindowHandler() {
	electronTrpc.browser.onAnyNewWindow.useSubscription(undefined, {
		onData: ({ paneId, url }) => {
			const state = useTabsStore.getState();
			const pane = state.panes[paneId];
			if (!pane) return;
			const tab = state.tabs.find((t) => t.id === pane.tabId);
			if (!tab) return;
			state.addBrowserTab(tab.workspaceId, url);
		},
	});
}
