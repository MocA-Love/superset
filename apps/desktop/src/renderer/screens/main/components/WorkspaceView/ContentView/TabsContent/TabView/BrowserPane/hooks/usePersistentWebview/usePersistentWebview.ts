import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { PLATFORM } from "shared/constants";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const webviewRegistry = new Map<string, Electron.WebviewTag>();
/**
 * A persistent wrapper div per pane that ALWAYS contains its webview.
 *
 * Electron's <webview> tag reloads its content whenever the element is
 * reparented (moved from one parent to another). The previous approach moved
 * the webview itself between a visible container and a hidden one — each move
 * was a reparent that triggered a reload.
 *
 * By wrapping the webview in a persistent div and only ever moving that
 * wrapper, the webview's parentNode never changes, so Electron never sees a
 * reparent. The wrapper moves between React's container div (visible) and a
 * hidden parking container, but the webview inside is untouched.
 */
const wrapperRegistry = new Map<string, HTMLDivElement>();
/** Tracks paneId → last-registered webContentsId so we can re-register if it changes. */
const registeredWebContentsIds = new Map<string, number>();
let hiddenContainer: HTMLDivElement | null = null;

function getHiddenContainer(): HTMLDivElement {
	if (!hiddenContainer) {
		hiddenContainer = document.createElement("div");
		hiddenContainer.style.position = "fixed";
		hiddenContainer.style.left = "-9999px";
		hiddenContainer.style.top = "-9999px";
		hiddenContainer.style.width = "100vw";
		hiddenContainer.style.height = "100vh";
		hiddenContainer.style.overflow = "hidden";
		hiddenContainer.style.pointerEvents = "none";
		document.body.appendChild(hiddenContainer);
	}
	return hiddenContainer;
}

// ---------------------------------------------------------------------------
// Disable webview interaction during ANY drag operation.
// Electron <webview> tags create separate compositor layers that swallow
// drag events before they reach the mosaic drop targets. Setting
// pointer-events:none directly on the <webview> element tells the
// compositor to stop routing events to the guest process.
//
// We use native HTML5 drag events (capture phase) rather than the drag pane
// store because the store only covers mosaic pane drags — not tab-bar drags
// or other drag sources.
// ---------------------------------------------------------------------------

function setWebviewsDragPassthrough(passthrough: boolean) {
	for (const webview of webviewRegistry.values()) {
		webview.style.pointerEvents = passthrough ? "none" : "";
	}
}

window.addEventListener(
	"dragstart",
	() => setWebviewsDragPassthrough(true),
	true,
);
window.addEventListener(
	"dragend",
	() => setWebviewsDragPassthrough(false),
	true,
);
window.addEventListener("drop", () => setWebviewsDragPassthrough(false), true);

/** Call from useBrowserLifecycle when a pane is removed. */
export function destroyPersistentWebview(paneId: string): void {
	const wrapper = wrapperRegistry.get(paneId);
	if (wrapper) {
		wrapper.remove();
		wrapperRegistry.delete(paneId);
	}
	const webview = webviewRegistry.get(paneId);
	if (webview) {
		webview.remove();
		webviewRegistry.delete(paneId);
	}
	registeredWebContentsIds.delete(paneId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeUrl(url: string): string {
	if (/^https?:\/\//i.test(url) || url.startsWith("about:")) {
		return url;
	}
	if (url.startsWith("localhost") || url.startsWith("127.0.0.1")) {
		return `http://${url}`;
	}
	if (url.includes(".")) {
		return `https://${url}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UsePersistentWebviewOptions {
	paneId: string;
	initialUrl: string;
}

export function usePersistentWebview({
	paneId,
	initialUrl,
}: UsePersistentWebviewOptions) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const isHistoryNavigation = useRef(false);
	const faviconUrlRef = useRef<string | undefined>(undefined);
	const initialUrlRef = useRef(initialUrl);

	const navigateBrowserHistory = useTabsStore((s) => s.navigateBrowserHistory);
	const browserState = useTabsStore((s) => s.panes[paneId]?.browser);
	const historyIndex = browserState?.historyIndex ?? 0;
	const historyLength = browserState?.history.length ?? 0;
	const canGoBack = historyIndex > 0;
	const canGoForward = historyIndex < historyLength - 1;

	const { mutate: registerBrowser } =
		electronTrpc.browser.register.useMutation();
	const { mutate: upsertHistory } =
		electronTrpc.browserHistory.upsert.useMutation();

	// New-window events (target="_blank", window.open) are handled globally
	// by useBrowserNewWindowHandler in the dashboard layout, so webviews that
	// are parked in the hidden container still get their events handled.

	// Subscribe to context menu actions (e.g. "Open Link as New Split")
	electronTrpc.browser.onContextMenuAction.useSubscription(
		{ paneId },
		{
			onData: ({ action, url }: { action: string; url: string }) => {
				if (action === "open-in-split") {
					const state = useTabsStore.getState();
					const pane = state.panes[paneId];
					if (!pane) return;
					const tab = state.tabs.find((t) => t.id === pane.tabId);
					if (!tab) return;
					state.openInBrowserPane(tab.workspaceId, url);
				}
			},
		},
	);

	// Sync store from webview state (handles agent-triggered navigation while hidden)
	const syncStoreFromWebview = useCallback(
		(webview: Electron.WebviewTag) => {
			try {
				const url = webview.getURL();
				const title = webview.getTitle();
				if (url) {
					const store = useTabsStore.getState();
					const currentUrl = store.panes[paneId]?.browser?.currentUrl;
					if (url !== currentUrl) {
						store.updateBrowserUrl(
							paneId,
							url,
							title ?? "",
							faviconUrlRef.current,
						);
					}
				}
			} catch {
				// webview may not be ready
			}
		},
		[paneId],
	);

	// Main lifecycle effect: create or reclaim wrapper+webview, attach events, park on unmount
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let wrapper = wrapperRegistry.get(paneId);
		let webview = webviewRegistry.get(paneId);

		if (wrapper && webview) {
			// Reclaim: move the wrapper (with webview inside) into React's container.
			// The webview's parentNode stays as `wrapper` — no reparent, no reload.
			container.appendChild(wrapper);
			syncStoreFromWebview(webview);
		} else {
			// First time: create a persistent wrapper div and a webview inside it.
			wrapper = document.createElement("div");
			wrapper.style.display = "flex";
			wrapper.style.flex = "1";
			wrapper.style.width = "100%";
			wrapper.style.height = "100%";

			webview = document.createElement("webview") as Electron.WebviewTag;
			webview.setAttribute("partition", "persist:superset");
			webview.setAttribute("allowpopups", "");
			webview.style.display = "flex";
			webview.style.flex = "1";
			webview.style.width = "100%";
			webview.style.height = "100%";
			webview.style.border = "none";

			// webview goes into wrapper, wrapper goes into container
			wrapper.appendChild(webview);
			wrapperRegistry.set(paneId, wrapper);
			webviewRegistry.set(paneId, webview);
			container.appendChild(wrapper);

			const finalUrl = sanitizeUrl(initialUrlRef.current);
			webview.src = finalUrl;
		}

		const wv = webview;

		// -- Event handlers ------------------------------------------------

		const handleDomReady = () => {
			const webContentsId = wv.getWebContentsId();
			const previousId = registeredWebContentsIds.get(paneId);
			// Register on first load, or re-register if webContentsId changed
			if (previousId !== webContentsId) {
				registeredWebContentsIds.set(paneId, webContentsId);
				registerBrowser({ paneId, webContentsId });
			}

			// Inject mouse back/forward button support into the guest page.
			// Electron's <webview> consumes mouse events in the guest process,
			// so the host renderer never sees button 3/4 (back/forward).
			// Only needed on macOS — Windows/Linux use the `app-command` event
			// handler in the main process instead.
			if (PLATFORM.IS_MAC) {
				wv.executeJavaScript(`
					if (!window.__supersetMouseNavInstalled) {
						window.__supersetMouseNavInstalled = true;
						window.addEventListener('mouseup', function(e) {
							if (e.button === 3) { e.preventDefault(); history.back(); }
							if (e.button === 4) { e.preventDefault(); history.forward(); }
						}, true);
					}
				`).catch(() => {});
			}

			// Cmd/Ctrl+click on links opens in a new browser tab.
			// Chromium may not always trigger setWindowOpenHandler for modifier
			// clicks, so we intercept them in the guest page and call window.open
			// which is reliably caught by the handler.
			wv.executeJavaScript(`
				if (!window.__supersetCmdClickInstalled) {
					window.__supersetCmdClickInstalled = true;
					document.addEventListener('click', function(e) {
						if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
						var el = e.target;
						while (el && el.tagName !== 'A') el = el.parentElement;
						if (el && el.href && !el.href.startsWith('javascript:')) {
							e.preventDefault();
							e.stopPropagation();
							window.open(el.href, '_blank');
						}
					}, true);
				}
			`).catch(() => {});
		};

		const handleDidStartLoading = () => {
			const store = useTabsStore.getState();
			store.updateBrowserLoading(paneId, true);
			store.setBrowserError(paneId, null);
			faviconUrlRef.current = undefined;
		};

		const handleDidStopLoading = () => {
			const store = useTabsStore.getState();
			store.updateBrowserLoading(paneId, false);

			if (isHistoryNavigation.current) {
				isHistoryNavigation.current = false;
				return;
			}

			try {
				const url = wv.getURL();
				const title = wv.getTitle();
				store.updateBrowserUrl(
					paneId,
					url ?? "",
					title ?? "",
					faviconUrlRef.current,
				);

				if (url && url !== "about:blank") {
					upsertHistory({
						url,
						title: title ?? "",
						faviconUrl: faviconUrlRef.current ?? null,
					});
				}
			} catch {
				// Webview may not be attached to DOM (e.g. parked in hidden container)
			}
		};

		const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
			if (isHistoryNavigation.current) {
				isHistoryNavigation.current = false;
				return;
			}
			const store = useTabsStore.getState();
			store.updateBrowserUrl(
				paneId,
				e.url ?? "",
				wv.getTitle() ?? "",
				faviconUrlRef.current,
			);
			store.updateBrowserLoading(paneId, false);
		};

		const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
			if (isHistoryNavigation.current) {
				isHistoryNavigation.current = false;
				return;
			}
			const store = useTabsStore.getState();
			store.updateBrowserUrl(
				paneId,
				e.url ?? "",
				wv.getTitle() ?? "",
				faviconUrlRef.current,
			);
		};

		const handlePageTitleUpdated = (e: Electron.PageTitleUpdatedEvent) => {
			const store = useTabsStore.getState();
			const currentUrl = store.panes[paneId]?.browser?.currentUrl ?? "";
			store.updateBrowserUrl(
				paneId,
				currentUrl,
				e.title ?? "",
				faviconUrlRef.current,
			);
		};

		const handlePageFaviconUpdated = (e: Electron.PageFaviconUpdatedEvent) => {
			const favicons = e.favicons;
			if (favicons && favicons.length > 0) {
				faviconUrlRef.current = favicons[0];
				const store = useTabsStore.getState();
				const currentUrl = store.panes[paneId]?.browser?.currentUrl ?? "";
				const currentTitle =
					store.panes[paneId]?.browser?.history[
						store.panes[paneId]?.browser?.historyIndex ?? 0
					]?.title ?? "";
				store.updateBrowserUrl(paneId, currentUrl, currentTitle, favicons[0]);
				if (currentUrl && currentUrl !== "about:blank") {
					upsertHistory({
						url: currentUrl,
						title: currentTitle,
						faviconUrl: favicons[0],
					});
				}
			}
		};

		const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
			if (e.errorCode === -3) return; // ERR_ABORTED
			const store = useTabsStore.getState();
			store.updateBrowserLoading(paneId, false);
			store.setBrowserError(paneId, {
				code: e.errorCode ?? 0,
				description: e.errorDescription ?? "",
				url: e.validatedURL ?? "",
			});
		};

		// -- Attach listeners ----------------------------------------------

		wv.addEventListener("dom-ready", handleDomReady);
		wv.addEventListener("did-start-loading", handleDidStartLoading);
		wv.addEventListener("did-stop-loading", handleDidStopLoading);
		wv.addEventListener("did-navigate", handleDidNavigate as EventListener);
		wv.addEventListener(
			"did-navigate-in-page",
			handleDidNavigateInPage as EventListener,
		);
		wv.addEventListener(
			"page-title-updated",
			handlePageTitleUpdated as EventListener,
		);
		wv.addEventListener(
			"page-favicon-updated",
			handlePageFaviconUpdated as EventListener,
		);
		wv.addEventListener("did-fail-load", handleDidFailLoad as EventListener);

		// -- Cleanup: park the wrapper (not the webview) in hidden container -

		return () => {
			wv.removeEventListener("dom-ready", handleDomReady);
			wv.removeEventListener("did-start-loading", handleDidStartLoading);
			wv.removeEventListener("did-stop-loading", handleDidStopLoading);
			wv.removeEventListener(
				"did-navigate",
				handleDidNavigate as EventListener,
			);
			wv.removeEventListener(
				"did-navigate-in-page",
				handleDidNavigateInPage as EventListener,
			);
			wv.removeEventListener(
				"page-title-updated",
				handlePageTitleUpdated as EventListener,
			);
			wv.removeEventListener(
				"page-favicon-updated",
				handlePageFaviconUpdated as EventListener,
			);
			wv.removeEventListener(
				"did-fail-load",
				handleDidFailLoad as EventListener,
			);

			// Park the WRAPPER (which contains the webview) in the hidden
			// container. The webview's parentNode remains `wrapper` throughout
			// — no reparent, no reload.
			const w = wrapperRegistry.get(paneId);
			if (w) {
				getHiddenContainer().appendChild(w);
			}
		};
		// paneId is stable for the lifetime of a pane; initialUrlRef only used on first create.
	}, [paneId, registerBrowser, syncStoreFromWebview, upsertHistory]);

	// -- Navigation methods (operate directly on the webview) ---------------

	const goBack = useCallback(() => {
		const url = navigateBrowserHistory(paneId, "back");
		if (url) {
			isHistoryNavigation.current = true;
			const webview = webviewRegistry.get(paneId);
			if (webview) webview.loadURL(sanitizeUrl(url));
		}
	}, [paneId, navigateBrowserHistory]);

	const goForward = useCallback(() => {
		const url = navigateBrowserHistory(paneId, "forward");
		if (url) {
			isHistoryNavigation.current = true;
			const webview = webviewRegistry.get(paneId);
			if (webview) webview.loadURL(sanitizeUrl(url));
		}
	}, [paneId, navigateBrowserHistory]);

	const reload = useCallback(() => {
		const webview = webviewRegistry.get(paneId);
		if (webview) webview.reload();
	}, [paneId]);

	const navigateTo = useCallback(
		(url: string) => {
			const webview = webviewRegistry.get(paneId);
			if (webview) webview.loadURL(sanitizeUrl(url));
		},
		[paneId],
	);

	return {
		containerRef,
		goBack,
		goForward,
		reload,
		navigateTo,
		canGoBack,
		canGoForward,
	};
}
