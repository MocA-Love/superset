import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { BrowserLoadError } from "shared/tabs-types";
import { sanitizeUrl } from "./sanitizeUrl";

export interface BrowserRuntimeState {
	currentUrl: string;
	pageTitle: string;
	faviconUrl: string | null;
	isLoading: boolean;
	error: BrowserLoadError | null;
	canGoBack: boolean;
	canGoForward: boolean;
}

export interface PersistableBrowserState {
	url: string;
	pageTitle: string;
	faviconUrl: string | null;
}

export interface BrowserTabSummary {
	tabId: string;
	url: string;
	title: string;
	faviconUrl: string | null;
	isLoading: boolean;
	isActive: boolean;
}

const EMPTY_STATE: BrowserRuntimeState = Object.freeze({
	currentUrl: "about:blank",
	pageTitle: "",
	faviconUrl: null,
	isLoading: false,
	error: null,
	canGoBack: false,
	canGoForward: false,
});

const ROOT_CONTAINER_ID = "browser-runtime-root";

let tabIdSeq = 0;
function generateTabId(): string {
	tabIdSeq += 1;
	return `tab-${Date.now().toString(36)}-${tabIdSeq.toString(36)}`;
}

interface TabEntry {
	tabId: string;
	webview: Electron.WebviewTag;
	state: BrowserRuntimeState;
	webContentsId: number | null;
	detachHandlers: () => void;
}

interface PaneGroup {
	tabs: TabEntry[];
	activeTabId: string;
	onPersist: ((state: PersistableBrowserState) => void) | null;
	placeholder: HTMLElement | null;
	resizeObserver: ResizeObserver | null;
	visible: boolean;
}

class BrowserRuntimeRegistryImpl {
	private groups = new Map<string, PaneGroup>();
	private stateListenersByPaneId = new Map<string, Set<() => void>>();
	private tabsListenersByPaneId = new Map<string, Set<() => void>>();
	// Snapshot caches so useSyncExternalStore returns stable references
	// until something actually changes — without this the array
	// identity flips every render and React aborts the BrowserPane
	// with "Maximum update depth exceeded".
	private tabsSnapshots = new Map<string, BrowserTabSummary[]>();
	private rootContainer: HTMLDivElement | null = null;
	private globalListenersInstalled = false;

	private getStateListeners(paneId: string): Set<() => void> {
		let set = this.stateListenersByPaneId.get(paneId);
		if (!set) {
			set = new Set();
			this.stateListenersByPaneId.set(paneId, set);
		}
		return set;
	}

	private getTabsListeners(paneId: string): Set<() => void> {
		let set = this.tabsListenersByPaneId.get(paneId);
		if (!set) {
			set = new Set();
			this.tabsListenersByPaneId.set(paneId, set);
		}
		return set;
	}

	private activeTab(paneId: string): TabEntry | null {
		const group = this.groups.get(paneId);
		if (!group) return null;
		return group.tabs.find((t) => t.tabId === group.activeTabId) ?? null;
	}

	private ensureRootContainer(): HTMLDivElement {
		if (this.rootContainer?.isConnected) return this.rootContainer;
		const existing = document.getElementById(
			ROOT_CONTAINER_ID,
		) as HTMLDivElement | null;
		if (existing) {
			this.rootContainer = existing;
			return existing;
		}
		const root = document.createElement("div");
		root.id = ROOT_CONTAINER_ID;
		root.style.position = "fixed";
		root.style.top = "0";
		root.style.left = "0";
		root.style.width = "0";
		root.style.height = "0";
		root.style.pointerEvents = "none";
		root.style.zIndex = "0";
		document.body.appendChild(root);
		this.rootContainer = root;
		this.installGlobalListeners();
		return root;
	}

	private installGlobalListeners() {
		if (this.globalListenersInstalled) return;
		this.globalListenersInstalled = true;
		const setPassthrough = (passthrough: boolean) => {
			for (const group of this.groups.values()) {
				if (!group.visible) continue;
				const active = group.tabs.find((t) => t.tabId === group.activeTabId);
				if (!active) continue;
				active.webview.style.pointerEvents = passthrough ? "none" : "auto";
			}
		};
		window.addEventListener("dragstart", () => setPassthrough(true), true);
		window.addEventListener("dragend", () => setPassthrough(false), true);
		window.addEventListener("drop", () => setPassthrough(false), true);
		window.addEventListener("resize", () => {
			for (const group of this.groups.values()) {
				if (group.placeholder) this.applyLayout(group);
			}
		});
	}

	private applyLayout(group: PaneGroup) {
		if (!group.placeholder) return;
		const rect = group.placeholder.getBoundingClientRect();
		for (const tab of group.tabs) {
			const w = tab.webview;
			const isActive = tab.tabId === group.activeTabId;
			// Inactive tabs are pushed off-screen rather than
			// `visibility:hidden` so Chromium does not flip the
			// underlying webContents into the page-lifecycle "hidden"
			// state. External CDP MCPs (browser-use, chrome-devtools-
			// mcp) drive sites that frequently pause work while hidden
			// (IntersectionObserver, requestAnimationFrame, deferred
			// load), which presents to the user as the MCP hanging.
			if (group.visible && isActive) {
				w.style.top = `${rect.top}px`;
				w.style.left = `${rect.left}px`;
				w.style.width = `${rect.width}px`;
				w.style.height = `${rect.height}px`;
				w.style.zIndex = "100";
				w.style.pointerEvents = "auto";
			} else {
				w.style.top = "-100000px";
				w.style.left = "-100000px";
				w.style.width = `${rect.width}px`;
				w.style.height = `${rect.height}px`;
				w.style.zIndex = "0";
				w.style.pointerEvents = "none";
			}
			w.style.visibility = "visible";
		}
	}

	private notifyState(paneId: string) {
		const set = this.stateListenersByPaneId.get(paneId);
		if (!set) return;
		for (const l of set) l();
	}

	private notifyTabs(paneId: string) {
		this.tabsSnapshots.delete(paneId);
		const set = this.tabsListenersByPaneId.get(paneId);
		if (!set) return;
		for (const l of set) l();
	}

	private setTabState(
		paneId: string,
		tabId: string,
		patch: Partial<BrowserRuntimeState>,
	) {
		const group = this.groups.get(paneId);
		if (!group) return;
		const tab = group.tabs.find((t) => t.tabId === tabId);
		if (!tab) return;
		let changed = false;
		for (const key in patch) {
			const k = key as keyof BrowserRuntimeState;
			if (tab.state[k] !== patch[k]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		tab.state = { ...tab.state, ...patch };
		if (tabId === group.activeTabId) this.notifyState(paneId);
		this.notifyTabs(paneId);
	}

	private refreshNavStateOf(paneId: string, tabId: string) {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === tabId);
		if (!tab) return;
		let canGoBack = false;
		let canGoForward = false;
		try {
			canGoBack = tab.webview.canGoBack();
			canGoForward = tab.webview.canGoForward();
		} catch {}
		this.setTabState(paneId, tabId, { canGoBack, canGoForward });
	}

	private registerTabWithMain(
		paneId: string,
		tabId: string,
		webContentsId: number,
		isPrimary: boolean,
	): void {
		if (isPrimary) {
			electronTrpcClient.browser.register
				.mutate({ paneId, webContentsId })
				.catch((err) => {
					console.error("[browserRuntimeRegistry] register failed:", err);
				});
			return;
		}
		electronTrpcClient.browser.registerTab
			.mutate({ paneId, tabId, webContentsId })
			.catch((err) => {
				console.error("[browserRuntimeRegistry] registerTab failed:", err);
			});
	}

	private unregisterTabWithMain(
		paneId: string,
		tabId: string,
		isPrimary: boolean,
	): void {
		if (isPrimary) return; // pane destroy handles primary unregister
		electronTrpcClient.browser.unregisterTab
			.mutate({ paneId, tabId })
			.catch(() => {});
	}

	private createTabEntry(
		paneId: string,
		initialUrl: string,
		tabId: string,
		isPrimary: boolean,
	): TabEntry {
		const webview = document.createElement("webview") as Electron.WebviewTag;
		webview.setAttribute("partition", "persist:superset");
		webview.setAttribute("allowpopups", "");
		webview.setAttribute("webpreferences", "transparent=no");
		webview.style.position = "fixed";
		webview.style.top = "0";
		webview.style.left = "0";
		webview.style.width = "0";
		webview.style.height = "0";
		webview.style.margin = "0";
		webview.style.padding = "0";
		webview.style.border = "none";
		webview.style.visibility = "hidden";
		webview.style.pointerEvents = "auto";
		const sanitized = sanitizeUrl(initialUrl);
		console.log(
			"[tab-diag v2] createTabEntry pane=",
			paneId,
			"tab=",
			tabId,
			"isPrimary=",
			isPrimary,
			"incomingUrl=",
			initialUrl,
			"sanitized=",
			sanitized,
		);
		webview.src = sanitized;

		const entry: TabEntry = {
			tabId,
			webview,
			state: { ...EMPTY_STATE, currentUrl: initialUrl },
			webContentsId: null,
			detachHandlers: () => {},
		};

		const firePersist = () => {
			const group = this.groups.get(paneId);
			if (!group || group.activeTabId !== tabId) return;
			group.onPersist?.({
				url: entry.state.currentUrl,
				pageTitle: entry.state.pageTitle,
				faviconUrl: entry.state.faviconUrl,
			});
		};

		const handleDomReady = () => {
			const webContentsId = webview.getWebContentsId();
			if (entry.webContentsId !== webContentsId) {
				entry.webContentsId = webContentsId;
				this.registerTabWithMain(paneId, tabId, webContentsId, isPrimary);
			}
		};

		const handleDidStartLoading = () => {
			this.setTabState(paneId, tabId, {
				isLoading: true,
				error: null,
				faviconUrl: null,
			});
		};

		const handleDidStopLoading = () => {
			const url = webview.getURL() ?? "";
			const title = webview.getTitle() ?? "";
			this.setTabState(paneId, tabId, {
				isLoading: false,
				currentUrl: url,
				pageTitle: title,
			});
			this.refreshNavStateOf(paneId, tabId);
			if (url && url !== "about:blank") {
				electronTrpcClient.browserHistory.upsert
					.mutate({ url, title, faviconUrl: entry.state.faviconUrl })
					.catch((err) => {
						console.error("[browserRuntimeRegistry] upsert history:", err);
					});
			}
			firePersist();
		};

		const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
			console.log(
				"[tab-diag v2] did-navigate pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				e.url,
			);
			const url = e.url ?? "";
			const title = webview.getTitle() ?? "";
			this.setTabState(paneId, tabId, {
				currentUrl: url,
				pageTitle: title,
				isLoading: false,
			});
			this.refreshNavStateOf(paneId, tabId);
			firePersist();
		};

		const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
			const url = e.url ?? "";
			const title = webview.getTitle() ?? "";
			this.setTabState(paneId, tabId, { currentUrl: url, pageTitle: title });
			this.refreshNavStateOf(paneId, tabId);
			firePersist();
		};

		const handlePageTitleUpdated = (e: Electron.PageTitleUpdatedEvent) => {
			this.setTabState(paneId, tabId, { pageTitle: e.title ?? "" });
			firePersist();
		};

		const handlePageFaviconUpdated = (e: Electron.PageFaviconUpdatedEvent) => {
			const favicon = e.favicons?.[0];
			if (!favicon || favicon === entry.state.faviconUrl) return;
			this.setTabState(paneId, tabId, { faviconUrl: favicon });
			const { currentUrl, pageTitle } = entry.state;
			if (currentUrl && currentUrl !== "about:blank") {
				electronTrpcClient.browserHistory.upsert
					.mutate({ url: currentUrl, title: pageTitle, faviconUrl: favicon })
					.catch((err) => {
						console.error("[browserRuntimeRegistry] upsert favicon:", err);
					});
			}
			firePersist();
		};

		const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
			console.warn(
				"[tab-diag v2] did-fail-load pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				e.validatedURL,
				"errorCode=",
				e.errorCode,
				"errorDesc=",
				e.errorDescription,
			);
			if (e.errorCode === -3) return; // ERR_ABORTED
			this.setTabState(paneId, tabId, {
				isLoading: false,
				error: {
					code: e.errorCode ?? 0,
					description: e.errorDescription ?? "",
					url: e.validatedURL ?? "",
				},
			});
		};

		webview.addEventListener("dom-ready", handleDomReady);
		webview.addEventListener("did-start-loading", handleDidStartLoading);
		webview.addEventListener("did-stop-loading", handleDidStopLoading);
		webview.addEventListener(
			"did-navigate",
			handleDidNavigate as EventListener,
		);
		webview.addEventListener(
			"did-navigate-in-page",
			handleDidNavigateInPage as EventListener,
		);
		webview.addEventListener(
			"page-title-updated",
			handlePageTitleUpdated as EventListener,
		);
		webview.addEventListener(
			"page-favicon-updated",
			handlePageFaviconUpdated as EventListener,
		);
		webview.addEventListener(
			"did-fail-load",
			handleDidFailLoad as EventListener,
		);

		// Close tab when the guest page closes itself or Chromium
		// destroys the webContents (MCP Target.closeTarget etc.).
		const handleClose = () => {
			this.closeTab(paneId, tabId);
		};
		webview.addEventListener("close", handleClose);

		entry.detachHandlers = () => {
			webview.removeEventListener("close", handleClose);
			webview.removeEventListener("dom-ready", handleDomReady);
			webview.removeEventListener("did-start-loading", handleDidStartLoading);
			webview.removeEventListener("did-stop-loading", handleDidStopLoading);
			webview.removeEventListener(
				"did-navigate",
				handleDidNavigate as EventListener,
			);
			webview.removeEventListener(
				"did-navigate-in-page",
				handleDidNavigateInPage as EventListener,
			);
			webview.removeEventListener(
				"page-title-updated",
				handlePageTitleUpdated as EventListener,
			);
			webview.removeEventListener(
				"page-favicon-updated",
				handlePageFaviconUpdated as EventListener,
			);
			webview.removeEventListener(
				"did-fail-load",
				handleDidFailLoad as EventListener,
			);
		};

		return entry;
	}

	attach(
		paneId: string,
		placeholder: HTMLElement,
		initialUrl: string,
		onPersist: (state: PersistableBrowserState) => void,
	): void {
		const root = this.ensureRootContainer();
		let group = this.groups.get(paneId);
		if (!group) {
			const primaryTabId = "primary";
			const entry = this.createTabEntry(paneId, initialUrl, primaryTabId, true);
			group = {
				tabs: [entry],
				activeTabId: primaryTabId,
				onPersist,
				placeholder,
				resizeObserver: null,
				visible: true,
			};
			this.groups.set(paneId, group);
			root.appendChild(entry.webview);
		} else {
			group.placeholder = placeholder;
			group.onPersist = onPersist;
			group.visible = true;
			const active = this.activeTab(paneId);
			if (active) this.refreshNavStateOf(paneId, active.tabId);
		}
		const active = this.activeTab(paneId);
		if (active) {
			group.onPersist?.({
				url: active.state.currentUrl,
				pageTitle: active.state.pageTitle,
				faviconUrl: active.state.faviconUrl,
			});
		}
		group.resizeObserver?.disconnect();
		const groupRef = group;
		const observer = new ResizeObserver(() => this.applyLayout(groupRef));
		observer.observe(placeholder);
		group.resizeObserver = observer;
		this.applyLayout(group);
		this.notifyTabs(paneId);
	}

	detach(paneId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		group.onPersist = null;
		group.placeholder = null;
		group.resizeObserver?.disconnect();
		group.resizeObserver = null;
		group.visible = false;
		// Keep tabs Chromium-visible (just off-screen) so CDP MCPs
		// that drive them through pane detach don't stall on
		// document.hidden.
		for (const t of group.tabs) {
			t.webview.style.top = "-100000px";
			t.webview.style.left = "-100000px";
			t.webview.style.pointerEvents = "none";
			t.webview.style.visibility = "visible";
		}
	}

	destroy(paneId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		group.resizeObserver?.disconnect();
		for (const t of group.tabs) {
			t.detachHandlers();
			t.webview.remove();
			if (t.tabId !== "primary") {
				this.unregisterTabWithMain(paneId, t.tabId, false);
			}
		}
		this.groups.delete(paneId);
		this.stateListenersByPaneId.delete(paneId);
		this.tabsListenersByPaneId.delete(paneId);
		electronTrpcClient.browser.unregister.mutate({ paneId }).catch(() => {});
	}

	navigate(paneId: string, url: string): void {
		const active = this.activeTab(paneId);
		if (!active) return;
		active.webview.loadURL(sanitizeUrl(url)).catch((err) => {
			console.error("[browserRuntimeRegistry] loadURL failed:", err);
		});
	}

	goBack(paneId: string): void {
		const active = this.activeTab(paneId);
		if (active?.webview.canGoBack()) active.webview.goBack();
	}

	goForward(paneId: string): void {
		const active = this.activeTab(paneId);
		if (active?.webview.canGoForward()) active.webview.goForward();
	}

	reload(paneId: string): void {
		const active = this.activeTab(paneId);
		active?.webview.reload();
	}

	getState(paneId: string): BrowserRuntimeState {
		return this.activeTab(paneId)?.state ?? EMPTY_STATE;
	}

	onStateChange(paneId: string, listener: () => void): () => void {
		const set = this.getStateListeners(paneId);
		set.add(listener);
		return () => set.delete(listener);
	}

	private static EMPTY_TABS: BrowserTabSummary[] = Object.freeze(
		[] as BrowserTabSummary[],
	) as BrowserTabSummary[];

	listTabs(paneId: string): BrowserTabSummary[] {
		const cached = this.tabsSnapshots.get(paneId);
		if (cached) return cached;
		const group = this.groups.get(paneId);
		const next = group
			? group.tabs.map((t) => ({
					tabId: t.tabId,
					url: t.state.currentUrl,
					title: t.state.pageTitle,
					faviconUrl: t.state.faviconUrl,
					isLoading: t.state.isLoading,
					isActive: t.tabId === group.activeTabId,
				}))
			: BrowserRuntimeRegistryImpl.EMPTY_TABS;
		this.tabsSnapshots.set(paneId, next);
		return next;
	}

	onTabsChange(paneId: string, listener: () => void): () => void {
		const set = this.getTabsListeners(paneId);
		set.add(listener);
		return () => set.delete(listener);
	}

	createTab(
		paneId: string,
		url?: string,
		options?: { background?: boolean },
	): string | null {
		const root = this.ensureRootContainer();
		const group = this.groups.get(paneId);
		if (!group) return null;
		const tabId = generateTabId();
		const entry = this.createTabEntry(
			paneId,
			url ?? "about:blank",
			tabId,
			false,
		);
		group.tabs.push(entry);
		root.appendChild(entry.webview);
		if (!options?.background) {
			group.activeTabId = tabId;
		}
		this.applyLayout(group);
		this.notifyState(paneId);
		this.notifyTabs(paneId);
		return tabId;
	}

	/**
	 * Activate the pane's primary tab (the one created during
	 * register() with tabId "primary"). Used when the MCP flips
	 * focus back to the primary via Target.activateTarget.
	 */
	showPrimary(paneId: string): void {
		this.activateTab(paneId, "primary");
	}

	closeTab(paneId: string, tabId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		if (group.tabs.length <= 1) return; // keep at least one tab
		const idx = group.tabs.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return;
		const [removed] = group.tabs.splice(idx, 1);
		removed.detachHandlers();
		removed.webview.remove();
		if (removed.tabId !== "primary") {
			this.unregisterTabWithMain(paneId, removed.tabId, false);
		}
		if (group.activeTabId === tabId) {
			const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
			group.activeTabId = next.tabId;
		}
		this.applyLayout(group);
		this.notifyState(paneId);
		this.notifyTabs(paneId);
	}

	activateTab(paneId: string, tabId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		if (!group.tabs.some((t) => t.tabId === tabId)) return;
		if (group.activeTabId === tabId) return;
		group.activeTabId = tabId;
		this.applyLayout(group);
		// Re-persist the newly active tab's state so the toolbar /
		// pane header reflect it.
		const active = this.activeTab(paneId);
		if (active) {
			group.onPersist?.({
				url: active.state.currentUrl,
				pageTitle: active.state.pageTitle,
				faviconUrl: active.state.faviconUrl,
			});
		}
		this.notifyState(paneId);
		this.notifyTabs(paneId);
	}
}

export const browserRuntimeRegistry: BrowserRuntimeRegistryImpl =
	(import.meta.hot?.data?.browserRegistry as
		| BrowserRuntimeRegistryImpl
		| undefined) ?? new BrowserRuntimeRegistryImpl();

if (import.meta.hot) {
	import.meta.hot.data.browserRegistry = browserRuntimeRegistry;
}
