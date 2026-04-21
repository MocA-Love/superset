import { electronTrpcClient } from "renderer/lib/trpc-client";
import { sanitizeUrl } from "../usePersistentWebview/runtime";

/**
 * Secondary-tab registry for the v1 BrowserPane.
 *
 * v1's persistent webview machinery (usePersistentWebview + tabs-store
 * `browser`) is designed around a single primary webview per pane and
 * is deeply integrated with bookmarks, history, find-in-page, zoom,
 * etc. Rather than untangle that singleton assumption, this sidecar
 * runs alongside it: it owns *additional* webviews that share the
 * pane's placeholder. The primary stays in usePersistentWebview; when
 * the user (or an external CDP MCP via Target.createTarget) opens a
 * secondary tab, we spawn another <webview> and overlay it atop the
 * same placeholder.
 *
 * The pane's PaneTabBar decides which tab is active and tells this
 * registry to show/hide accordingly; the primary is hidden from the
 * outside by flipping the primary webview's CSS visibility.
 */

export interface SecondaryTabState {
	tabId: string;
	url: string;
	title: string;
	faviconUrl: string | null;
	isLoading: boolean;
}

interface TabEntry {
	tabId: string;
	webview: Electron.WebviewTag;
	state: SecondaryTabState;
	webContentsId: number | null;
	detachHandlers: () => void;
}

interface PaneGroup {
	tabs: TabEntry[];
	activeTabId: string | null;
	placeholder: HTMLElement | null;
	resizeObserver: ResizeObserver | null;
	visible: boolean;
}

const ROOT_ID = "browser-secondary-tab-root";

let tabIdSeq = 0;
function nextTabId(): string {
	tabIdSeq += 1;
	return `tab-${Date.now().toString(36)}-${tabIdSeq.toString(36)}`;
}

class SecondaryTabRegistry {
	private groups = new Map<string, PaneGroup>();
	private listenersByPaneId = new Map<string, Set<() => void>>();
	// Snapshot cache so useSyncExternalStore's getSnapshot returns the
	// same array reference until something actually changes — without
	// this, every render schedules another render and React aborts with
	// "Maximum update depth exceeded".
	private snapshots = new Map<string, SecondaryTabState[]>();
	private root: HTMLDivElement | null = null;
	private globalListenersInstalled = false;

	private ensureRoot(): HTMLDivElement {
		if (this.root?.isConnected) return this.root;
		const existing = document.getElementById(ROOT_ID) as HTMLDivElement | null;
		if (existing) {
			this.root = existing;
			return existing;
		}
		const el = document.createElement("div");
		el.id = ROOT_ID;
		el.style.position = "fixed";
		el.style.top = "0";
		el.style.left = "0";
		el.style.width = "0";
		el.style.height = "0";
		el.style.pointerEvents = "none";
		el.style.zIndex = "0";
		document.body.appendChild(el);
		this.root = el;
		this.installGlobal();
		return el;
	}

	private installGlobal(): void {
		if (this.globalListenersInstalled) return;
		this.globalListenersInstalled = true;
		window.addEventListener("resize", () => {
			for (const g of this.groups.values()) {
				if (g.placeholder) this.layout(g);
			}
		});
	}

	private notify(paneId: string): void {
		this.snapshots.delete(paneId);
		const set = this.listenersByPaneId.get(paneId);
		if (!set) return;
		for (const l of set) l();
	}

	private getListeners(paneId: string): Set<() => void> {
		let set = this.listenersByPaneId.get(paneId);
		if (!set) {
			set = new Set();
			this.listenersByPaneId.set(paneId, set);
		}
		return set;
	}

	private layout(group: PaneGroup): void {
		if (!group.placeholder) return;
		const rect = group.placeholder.getBoundingClientRect();
		for (const tab of group.tabs) {
			const w = tab.webview;
			const isActive = group.visible && tab.tabId === group.activeTabId;
			// Inactive tabs are pushed far off-screen rather than
			// `visibility:hidden`. Hiding via CSS triggers Chromium's
			// page-lifecycle "hidden" state on the underlying
			// webContents, which makes external CDP MCPs (browser-use
			// etc.) appear to hang while the page they're driving is
			// throttled by the site itself (IntersectionObserver,
			// requestAnimationFrame pauses, "wait until visible" load
			// patterns, …). Keeping the webview at its real size but
			// offscreen avoids that without showing it to the user.
			if (isActive) {
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

	private patchState(
		paneId: string,
		tabId: string,
		patch: Partial<SecondaryTabState>,
	): void {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === tabId);
		if (!tab) return;
		let changed = false;
		for (const key in patch) {
			const k = key as keyof SecondaryTabState;
			if (tab.state[k] !== patch[k]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		tab.state = { ...tab.state, ...patch };
		this.notify(paneId);
	}

	private spawnTab(paneId: string, url: string, tabId: string): TabEntry {
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
		const sanitized = sanitizeUrl(url);
		console.log(
			"[tab-diag v1] spawnTab pane=",
			paneId,
			"tab=",
			tabId,
			"incomingUrl=",
			url,
			"sanitized=",
			sanitized,
		);
		webview.src = sanitized;

		const entry: TabEntry = {
			tabId,
			webview,
			state: {
				tabId,
				url,
				title: "",
				faviconUrl: null,
				isLoading: false,
			},
			webContentsId: null,
			detachHandlers: () => {},
		};

		const handleDomReady = () => {
			const id = webview.getWebContentsId();
			console.log(
				"[v1 secondary-tabs] dom-ready pane=",
				paneId,
				"tab=",
				tabId,
				"webContentsId=",
				id,
			);
			if (entry.webContentsId !== id) {
				entry.webContentsId = id;
				electronTrpcClient.browser.registerTab
					.mutate({ paneId, tabId, webContentsId: id })
					.then(() =>
						console.log(
							"[v1 secondary-tabs] registerTab OK pane=",
							paneId,
							"tab=",
							tabId,
						),
					)
					.catch((err) =>
						console.error("[v1 secondary-tabs] registerTab failed:", err),
					);
			}
		};
		const handleDidStartLoading = () => {
			console.log(
				"[tab-diag v1] did-start-loading pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				webview.getURL?.(),
			);
			this.patchState(paneId, tabId, { isLoading: true });
		};
		const handleDidStopLoading = () => {
			const u = webview.getURL() ?? "";
			const t = webview.getTitle() ?? "";
			console.log(
				"[tab-diag v1] did-stop-loading pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				u,
				"title=",
				t,
			);
			this.patchState(paneId, tabId, { isLoading: false, url: u, title: t });
		};
		const handleDidFailLoad = (
			e: Electron.DidFailLoadEvent & { validatedURL?: string },
		) => {
			console.warn(
				"[tab-diag v1] did-fail-load pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				e.validatedURL ?? webview.getURL?.(),
				"errorCode=",
				e.errorCode,
				"errorDesc=",
				e.errorDescription,
			);
		};
		const handleDidNav = (e: Electron.DidNavigateEvent) => {
			console.log(
				"[tab-diag v1] did-navigate pane=",
				paneId,
				"tab=",
				tabId,
				"url=",
				e.url,
			);
			this.patchState(paneId, tabId, {
				url: e.url ?? "",
				title: webview.getTitle() ?? "",
				isLoading: false,
			});
		};
		const handleDidNavInPage = (e: Electron.DidNavigateInPageEvent) => {
			this.patchState(paneId, tabId, {
				url: e.url ?? "",
				title: webview.getTitle() ?? "",
			});
		};
		const handleTitle = (e: Electron.PageTitleUpdatedEvent) => {
			this.patchState(paneId, tabId, { title: e.title ?? "" });
		};
		const handleFavicon = (e: Electron.PageFaviconUpdatedEvent) => {
			const favicon = e.favicons?.[0] ?? null;
			if (favicon !== entry.state.faviconUrl) {
				this.patchState(paneId, tabId, { faviconUrl: favicon });
			}
		};

		webview.addEventListener("dom-ready", handleDomReady);
		webview.addEventListener("did-start-loading", handleDidStartLoading);
		webview.addEventListener("did-stop-loading", handleDidStopLoading);
		webview.addEventListener("did-fail-load", handleDidFailLoad as EventListener);
		webview.addEventListener("did-navigate", handleDidNav as EventListener);
		webview.addEventListener(
			"did-navigate-in-page",
			handleDidNavInPage as EventListener,
		);
		webview.addEventListener(
			"page-title-updated",
			handleTitle as EventListener,
		);
		webview.addEventListener(
			"page-favicon-updated",
			handleFavicon as EventListener,
		);

		// Fires when the guest page attempts to close itself OR when
		// Chromium destroys the underlying webContents (e.g. MCP sends
		// Target.closeTarget for this tab's targetId). Without this
		// listener the tab's webview element would stay dead in the
		// DOM and the registry would still list it as alive, while the
		// CDP filter has already pruned its targetId.
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
				"did-fail-load",
				handleDidFailLoad as EventListener,
			);
			webview.removeEventListener(
				"did-navigate",
				handleDidNav as EventListener,
			);
			webview.removeEventListener(
				"did-navigate-in-page",
				handleDidNavInPage as EventListener,
			);
			webview.removeEventListener(
				"page-title-updated",
				handleTitle as EventListener,
			);
			webview.removeEventListener(
				"page-favicon-updated",
				handleFavicon as EventListener,
			);
		};

		return entry;
	}

	attach(paneId: string, placeholder: HTMLElement): void {
		const root = this.ensureRoot();
		let group = this.groups.get(paneId);
		if (!group) {
			group = {
				tabs: [],
				activeTabId: null,
				placeholder,
				resizeObserver: null,
				visible: false,
			};
			this.groups.set(paneId, group);
		} else {
			group.placeholder = placeholder;
		}
		for (const tab of group.tabs) {
			if (!tab.webview.isConnected) root.appendChild(tab.webview);
		}
		group.resizeObserver?.disconnect();
		const ref = group;
		const observer = new ResizeObserver(() => this.layout(ref));
		observer.observe(placeholder);
		group.resizeObserver = observer;
		this.layout(group);
	}

	detach(paneId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		group.resizeObserver?.disconnect();
		group.resizeObserver = null;
		group.placeholder = null;
		group.visible = false;
		// Stay off-screen rather than visibility:hidden to keep
		// Chromium's page-lifecycle state "visible" so external CDP
		// MCPs driving these tabs don't stall when the pane detaches.
		for (const tab of group.tabs) {
			tab.webview.style.top = "-100000px";
			tab.webview.style.left = "-100000px";
			tab.webview.style.pointerEvents = "none";
			tab.webview.style.visibility = "visible";
		}
	}

	destroy(paneId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		group.resizeObserver?.disconnect();
		for (const tab of group.tabs) {
			tab.detachHandlers();
			tab.webview.remove();
			electronTrpcClient.browser.unregisterTab
				.mutate({ paneId, tabId: tab.tabId })
				.catch(() => {});
		}
		this.groups.delete(paneId);
		this.listenersByPaneId.delete(paneId);
	}

	setVisible(paneId: string, visible: boolean): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		group.visible = visible;
		this.layout(group);
	}

	createTab(
		paneId: string,
		url: string,
		options?: { background?: boolean },
	): string | null {
		this.ensureRoot();
		let group = this.groups.get(paneId);
		if (!group) {
			group = {
				tabs: [],
				activeTabId: null,
				placeholder: null,
				resizeObserver: null,
				visible: false,
			};
			this.groups.set(paneId, group);
		}
		const tabId = nextTabId();
		const entry = this.spawnTab(paneId, url, tabId);
		group.tabs.push(entry);
		if (this.root) this.root.appendChild(entry.webview);
		// Honour the CDP createTarget `background` flag: when set,
		// the new tab is spawned but the active tab stays put. When
		// unset (Chrome default for createTarget when called by MCP)
		// the new tab takes focus.
		if (!options?.background) {
			group.activeTabId = tabId;
			group.visible = true;
		}
		this.layout(group);
		this.notify(paneId);
		return tabId;
	}

	closeTab(paneId: string, tabId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		const idx = group.tabs.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return;
		const [removed] = group.tabs.splice(idx, 1);
		removed.detachHandlers();
		removed.webview.remove();
		electronTrpcClient.browser.unregisterTab
			.mutate({ paneId, tabId: removed.tabId })
			.catch(() => {});
		if (group.activeTabId === tabId) {
			group.activeTabId =
				group.tabs[Math.min(idx, group.tabs.length - 1)]?.tabId ?? null;
		}
		this.layout(group);
		this.notify(paneId);
	}

	activateTab(paneId: string, tabId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		if (!group.tabs.some((t) => t.tabId === tabId)) return;
		if (group.activeTabId === tabId) return;
		group.activeTabId = tabId;
		group.visible = true;
		this.layout(group);
		this.notify(paneId);
	}

	/**
	 * Hide any secondary tabs for this pane so the pane's primary
	 * (managed by usePersistentWebview) becomes visible. Used when
	 * MCP activates the primary target via Target.activateTarget.
	 */
	showPrimary(paneId: string): void {
		const group = this.groups.get(paneId);
		if (!group) return;
		if (group.activeTabId === null && !group.visible) return;
		group.activeTabId = null;
		group.visible = false;
		this.layout(group);
		this.notify(paneId);
	}

	private static EMPTY: SecondaryTabState[] = Object.freeze(
		[] as SecondaryTabState[],
	) as SecondaryTabState[];

	listTabs(paneId: string): SecondaryTabState[] {
		const cached = this.snapshots.get(paneId);
		if (cached) return cached;
		const group = this.groups.get(paneId);
		const next = group
			? group.tabs.map((t) => ({ ...t.state }))
			: SecondaryTabRegistry.EMPTY;
		this.snapshots.set(paneId, next);
		return next;
	}

	getActiveTabId(paneId: string): string | null {
		return this.groups.get(paneId)?.activeTabId ?? null;
	}

	onTabsChange(paneId: string, listener: () => void): () => void {
		const set = this.getListeners(paneId);
		set.add(listener);
		return () => set.delete(listener);
	}

	navigateActive(paneId: string, url: string): void {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === group.activeTabId);
		if (!tab) return;
		tab.webview.loadURL(sanitizeUrl(url)).catch(() => {});
	}

	goBackActive(paneId: string): void {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === group.activeTabId);
		if (tab?.webview.canGoBack()) tab.webview.goBack();
	}

	goForwardActive(paneId: string): void {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === group.activeTabId);
		if (tab?.webview.canGoForward()) tab.webview.goForward();
	}

	reloadActive(paneId: string): void {
		const group = this.groups.get(paneId);
		const tab = group?.tabs.find((t) => t.tabId === group.activeTabId);
		tab?.webview.reload();
	}
}

export const secondaryTabRegistry: SecondaryTabRegistry =
	(import.meta.hot?.data?.v1SecondaryTabRegistry as
		| SecondaryTabRegistry
		| undefined) ?? new SecondaryTabRegistry();
if (import.meta.hot) {
	import.meta.hot.data.v1SecondaryTabRegistry = secondaryTabRegistry;
}
