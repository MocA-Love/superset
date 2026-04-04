import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserFullscreenStore } from "renderer/stores/browser-fullscreen";

/**
 * Global handler for HTML5 fullscreen events from any browser pane.
 *
 * Updates the fullscreen store so BrowserPane components can react by
 * hiding their toolbar/bookmarks and letting the webview fill the pane.
 *
 * Must be mounted in an always-rendered component (dashboard layout).
 */
export function useBrowserFullscreenHandler() {
	const setFullscreenPane = useBrowserFullscreenStore(
		(s) => s.setFullscreenPane,
	);

	electronTrpc.browser.onFullscreenChange.useSubscription(undefined, {
		onData: ({ paneId, isFullscreen }) => {
			setFullscreenPane(isFullscreen ? paneId : null);
		},
	});
}
