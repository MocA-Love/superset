import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import {
	app,
	type BrowserWindow,
	clipboard,
	nativeTheme,
	session,
	shell,
	WebContentsView,
} from "electron";

/**
 * WebContentsView-based browser pane manager (v3).
 *
 * The original design used <webview> tags in the renderer. <webview>
 * is an OOPIF-backed BrowserPlugin whose native compositor does not
 * respect CSS z-index / pointer-events / opacity reliably when
 * multiple webviews overlap, which caused:
 *   - inactive tabs capturing wheel / context menu / focus
 *   - URL suggestion popover clicks being swallowed
 *   - ghost painting across tab switches
 *   - scroll locking up
 *
 * WebContentsView is the Electron-recommended replacement. Each
 * browser pane owns N WebContentsView instances; the main process
 * manages bounds, visibility, and child order directly on the host
 * BrowserWindow. DOM overlays (toolbar, tab bar, find-in-page) live
 * outside the view bounds; nothing is stacked underneath the view so
 * the native compositor's quirks cannot bite us.
 *
 * The renderer exposes a placeholder `<div>` whose bounding rect it
 * reports through tRPC. The manager syncs the view to that rect.
 */

const BROWSER_PARTITION = "persist:superset";

export interface ViewBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ViewEntry {
	tabId: string;
	view: WebContentsView;
	state: {
		currentUrl: string;
		pageTitle: string;
		faviconUrl: string | null;
		isLoading: boolean;
		canGoBack: boolean;
		canGoForward: boolean;
		error: { code: number; description: string; url: string } | null;
	};
	cdpTargetId: string | null;
}

interface PaneEntry {
	paneId: string;
	window: BrowserWindow;
	/** CSS-pixel bounds reported by the renderer's placeholder. */
	bounds: ViewBounds;
	activeTabId: string;
	tabs: ViewEntry[];
	/** True when the pane's owning workspace tab is actually visible in the UI. */
	hostVisible: boolean;
	/** True while DOM chrome temporarily needs click priority over the native view. */
	suspended: boolean;
	/** True once attach() called and bounds applied at least once. */
	attached: boolean;
}

export interface BrowserViewEvent {
	paneId: string;
	tabId: string;
}

export type TabStateSnapshot = ViewEntry["state"] & { tabId: string };

class BrowserViewManager extends EventEmitter {
	private panes = new Map<string, PaneEntry>();

	/**
	 * Register a pane with its host window. Called by the renderer on
	 * mount; subsequent setBounds / createTab / activateTab operations
	 * target this paneId.
	 */
	register(paneId: string, window: BrowserWindow, initialUrl: string): void {
		if (this.panes.has(paneId)) {
			const existing = this.panes.get(paneId);
			if (existing && existing.window === window) return;
			this.unregister(paneId);
		}
		const pane: PaneEntry = {
			paneId,
			window,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			activeTabId: "primary",
			tabs: [],
			hostVisible: false,
			suspended: false,
			attached: false,
		};
		this.panes.set(paneId, pane);
		this.spawnTab(pane, "primary", initialUrl);
	}

	unregister(paneId: string): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		for (const tab of pane.tabs) {
			this.destroyTabView(pane, tab);
		}
		this.panes.delete(paneId);
	}

	setBounds(paneId: string, bounds: ViewBounds): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		pane.bounds = {
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(0, Math.round(bounds.width)),
			height: Math.max(0, Math.round(bounds.height)),
		};
		pane.attached = true;
		this.applyLayout(pane);
	}

	setHostVisibility(paneId: string, visible: boolean): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		if (pane.hostVisible === visible) return;
		pane.hostVisible = visible;
		this.applyLayout(pane);
	}

	createTab(paneId: string, url: string, activate = true): string | null {
		const pane = this.panes.get(paneId);
		if (!pane) return null;
		const tabId = `tab-${Date.now().toString(36)}-${Math.floor(
			Math.random() * 1e6,
		).toString(36)}`;
		this.spawnTab(pane, tabId, url);
		if (activate) {
			pane.activeTabId = tabId;
			this.applyLayout(pane);
		}
		this.emitTabs(pane);
		return tabId;
	}

	closeTab(paneId: string, tabId: string): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		const idx = pane.tabs.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return;
		const [removed] = pane.tabs.splice(idx, 1);
		this.destroyTabView(pane, removed);
		if (pane.activeTabId === tabId) {
			const next = pane.tabs[Math.min(idx, pane.tabs.length - 1)];
			pane.activeTabId = next?.tabId ?? "primary";
		}
		this.applyLayout(pane);
		this.emitTabs(pane);
	}

	activateTab(paneId: string, tabId: string): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		if (!pane.tabs.some((t) => t.tabId === tabId)) return;
		if (pane.activeTabId === tabId) return;
		pane.activeTabId = tabId;
		this.applyLayout(pane);
		this.emitTabs(pane);
	}

	navigate(paneId: string, url: string): void {
		const tab = this.getActiveTab(paneId);
		if (!tab) return;
		tab.view.webContents.loadURL(sanitizeUrl(url));
	}

	goBack(paneId: string): void {
		const tab = this.getActiveTab(paneId);
		if (tab?.view.webContents.navigationHistory.canGoBack()) {
			tab.view.webContents.navigationHistory.goBack();
		}
	}

	goForward(paneId: string): void {
		const tab = this.getActiveTab(paneId);
		if (tab?.view.webContents.navigationHistory.canGoForward()) {
			tab.view.webContents.navigationHistory.goForward();
		}
	}

	reload(paneId: string, hard = false): void {
		const tab = this.getActiveTab(paneId);
		if (!tab) return;
		if (hard) tab.view.webContents.reloadIgnoringCache();
		else tab.view.webContents.reload();
	}

	async screenshot(paneId: string): Promise<string> {
		const tab = this.getActiveTab(paneId);
		if (!tab) throw new Error(`No active tab for pane ${paneId}`);
		const image = await tab.view.webContents.capturePage();
		try {
			clipboard.writeImage(image);
		} catch (error) {
			console.error("[browser-view-manager] clipboard.writeImage failed:", error);
		}
		return image.toPNG().toString("base64");
	}

	listTabs(paneId: string): TabStateSnapshot[] {
		const pane = this.panes.get(paneId);
		if (!pane) return [];
		return pane.tabs.map((t) => ({ ...t.state, tabId: t.tabId }));
	}

	getActiveTabId(paneId: string): string | null {
		return this.panes.get(paneId)?.activeTabId ?? null;
	}

	openDevTools(paneId: string): void {
		const tab = this.getActiveTab(paneId);
		if (!tab) return;
		tab.view.webContents.openDevTools({ mode: "detach" });
	}

	findInPage(
		paneId: string,
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
	): number | null {
		const tab = this.getActiveTab(paneId);
		if (!tab || !text) return null;
		return tab.view.webContents.findInPage(text, options);
	}

	stopFindInPage(
		paneId: string,
		action: "clearSelection" | "keepSelection" | "activateSelection",
	): void {
		const tab = this.getActiveTab(paneId);
		if (!tab) return;
		tab.view.webContents.stopFindInPage(action);
	}

	getZoomLevel(paneId: string): number | null {
		const tab = this.getActiveTab(paneId);
		if (!tab) return null;
		return tab.view.webContents.getZoomLevel();
	}

	setZoomLevel(paneId: string, level: number): boolean {
		const tab = this.getActiveTab(paneId);
		if (!tab) return false;
		tab.view.webContents.setZoomLevel(level);
		return true;
	}

	/**
	 * Force-hide (or reveal) the active view. Used while a DOM
	 * overlay (URL suggestion popover, modal, split drag) needs to
	 * receive clicks without the native view stealing them.
	 */
	setSuspended(paneId: string, suspended: boolean): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		if (pane.suspended === suspended) return;
		pane.suspended = suspended;
		this.applyLayout(pane);
	}

	/* ------------------------------------------------------------ */

	private getActiveTab(paneId: string): ViewEntry | null {
		const pane = this.panes.get(paneId);
		if (!pane) return null;
		return pane.tabs.find((t) => t.tabId === pane.activeTabId) ?? null;
	}

	private spawnTab(pane: PaneEntry, tabId: string, url: string): void {
		const view = new WebContentsView({
			webPreferences: {
				partition: BROWSER_PARTITION,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				backgroundThrottling: false,
			},
		});
		view.setBackgroundColor(
			nativeTheme.shouldUseDarkColors ? "#252525" : "#ffffff",
		);
		view.webContents.setBackgroundThrottling(false);

		const entry: ViewEntry = {
			tabId,
			view,
			state: {
				currentUrl: url || "about:blank",
				pageTitle: "",
				faviconUrl: null,
				isLoading: false,
				canGoBack: false,
				canGoForward: false,
				error: null,
			},
			cdpTargetId: null,
		};

		this.wireEvents(pane, entry);
		pane.tabs.push(entry);
		pane.window.contentView.addChildView(view);
		view.setVisible(false);

		void view.webContents.loadURL(sanitizeUrl(url || "about:blank"));
	}

	private destroyTabView(pane: PaneEntry, entry: ViewEntry): void {
		try {
			pane.window.contentView.removeChildView(entry.view);
		} catch {
			/* already detached */
		}
		try {
			entry.view.webContents.close();
		} catch {
			/* already closed */
		}
	}

	private applyLayout(pane: PaneEntry): void {
		if (!pane.attached) return;
		const { x, y, width, height } = pane.bounds;
		const shouldShowActiveView =
			pane.hostVisible && !pane.suspended && width > 0 && height > 0;
		for (const tab of pane.tabs) {
			const isActive = shouldShowActiveView && tab.tabId === pane.activeTabId;
			if (isActive) {
				try {
					tab.view.setBounds({ x, y, width, height });
					tab.view.setVisible(true);
				} catch {
					/* view may have been destroyed */
				}
			} else {
				try {
					tab.view.setVisible(false);
				} catch {
					/* ignore */
				}
			}
		}
	}

	private wireEvents(pane: PaneEntry, entry: ViewEntry): void {
		const wc = entry.view.webContents;
		const patch = (patch: Partial<ViewEntry["state"]>) => {
			entry.state = { ...entry.state, ...patch };
			this.emitTab(pane, entry);
		};

		wc.on("did-start-loading", () => patch({ isLoading: true, error: null }));
		wc.on("did-stop-loading", () => {
			patch({
				isLoading: false,
				currentUrl: wc.getURL(),
				pageTitle: wc.getTitle(),
				canGoBack: wc.navigationHistory.canGoBack(),
				canGoForward: wc.navigationHistory.canGoForward(),
			});
		});
		wc.on("did-navigate", (_e, url) => {
			patch({
				currentUrl: url,
				pageTitle: wc.getTitle(),
				canGoBack: wc.navigationHistory.canGoBack(),
				canGoForward: wc.navigationHistory.canGoForward(),
				error: null,
			});
		});
		wc.on("did-navigate-in-page", (_e, url) => {
			patch({
				currentUrl: url,
				pageTitle: wc.getTitle(),
				canGoBack: wc.navigationHistory.canGoBack(),
				canGoForward: wc.navigationHistory.canGoForward(),
			});
		});
		wc.on("page-title-updated", (_e, title) => patch({ pageTitle: title }));
		wc.on("page-favicon-updated", (_e, favicons) =>
			patch({ faviconUrl: favicons[0] ?? null }),
		);
		wc.on("found-in-page", (_event, result) => {
			this.emit(`found-in-page:${pane.paneId}`, {
				requestId: result.requestId,
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
				finalUpdate: result.finalUpdate,
			});
		});
		wc.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			const isFindKey =
				(input.meta || input.control) &&
				input.key.toLowerCase() === "f" &&
				!input.alt &&
				!input.shift;
			if (isFindKey) {
				event.preventDefault();
				this.emit(`find-requested:${pane.paneId}`);
				return;
			}
			if (input.key === "Escape") {
				this.emit(`find-escape:${pane.paneId}`);
			}
		});
		wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
			if (errorCode === -3) return;
			patch({
				isLoading: false,
				error: {
					code: errorCode,
					description: errorDescription,
					url: validatedURL,
				},
			});
		});

		wc.setWindowOpenHandler(({ url, disposition }) => {
			if (!url || url === "about:blank") return { action: "deny" as const };
			if (disposition === "new-window") {
				// Treat as external open for now.
				void shell.openExternal(url);
				return { action: "deny" as const };
			}
			// Default: open in-pane as a new tab.
			this.createTab(pane.paneId, url, true);
			return { action: "deny" as const };
		});

		// Download handler — save to ~/Downloads.
		wc.session.on("will-download", (_e, item) => {
			const downloadsDir = app.getPath("downloads");
			const suggested = item.getFilename() || "download";
			item.setSavePath(join(downloadsDir, basename(suggested)));
			this.emit(`download-started:${pane.paneId}`, {
				filename: suggested,
				targetPath: item.getSavePath?.() ?? suggested,
				url: item.getURL(),
			});
		});

		wc.once("destroyed", () => {
			const idx = pane.tabs.indexOf(entry);
			if (idx >= 0) {
				pane.tabs.splice(idx, 1);
				if (pane.activeTabId === entry.tabId) {
					const next = pane.tabs[Math.max(0, idx - 1)];
					pane.activeTabId = next?.tabId ?? "primary";
				}
				this.applyLayout(pane);
				this.emitTabs(pane);
			}
		});
	}

	private emitTabs(pane: PaneEntry): void {
		this.emit(`tabs:${pane.paneId}`, {
			activeTabId: pane.activeTabId,
			tabs: this.listTabs(pane.paneId),
		});
	}

	private emitTab(pane: PaneEntry, entry: ViewEntry): void {
		this.emit(`tab-state:${pane.paneId}`, {
			tabId: entry.tabId,
			state: { ...entry.state },
		});
		this.emitTabs(pane);
	}
}

function sanitizeUrl(url: string): string {
	if (!url) return "about:blank";
	if (/^https?:\/\//i.test(url) || url.startsWith("about:")) return url;
	if (url.startsWith("localhost") || url.startsWith("127.0.0.1"))
		return `http://${url}`;
	if (url.includes(".")) return `https://${url}`;
	return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

export const browserViewManager = new BrowserViewManager();
// Access to the session so downstream modules can register permission
// handlers etc. on the same partition.
export function getBrowserViewSession() {
	return session.fromPartition(BROWSER_PARTITION);
}
