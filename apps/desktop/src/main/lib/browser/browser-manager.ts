import { EventEmitter } from "node:events";
import {
	type BrowserWindow,
	clipboard,
	Menu,
	nativeTheme,
	shell,
	webContents,
} from "electron";

interface ConsoleEntry {
	level: "log" | "warn" | "error" | "info" | "debug";
	message: string;
	timestamp: number;
}

const MAX_CONSOLE_ENTRIES = 500;

function buildElementPathScript(x: number, y: number): string {
	return `(function() {
		var el = document.elementFromPoint(${x}, ${y});
		if (!el) return null;
		function getCssSelector(element) {
			var parts = [];
			var current = element;
			while (current && current.nodeType === 1 && current !== document.documentElement) {
				var sel = current.tagName.toLowerCase();
				if (current.id) {
					parts.unshift('#' + CSS.escape(current.id));
					return parts.join(' > ');
				}
				var classes = Array.prototype.slice.call(current.classList, 0, 3).map(function(c) { return CSS.escape(c); });
				if (classes.length > 0) sel += '.' + classes.join('.');
				var parent = current.parentElement;
				if (parent) {
					var sameTag = Array.prototype.filter.call(parent.children, function(s) { return s.tagName === current.tagName; });
					if (sameTag.length > 1) sel += ':nth-of-type(' + (Array.prototype.indexOf.call(sameTag, current) + 1) + ')';
				}
				parts.unshift(sel);
				current = current.parentElement;
				if (parts.length >= 5) break;
			}
			return parts.join(' > ');
		}
		function getXPath(element) {
			if (element.id) return '//*[@id="' + element.id + '"]';
			var parts = [];
			var current = element;
			var truncated = false;
			while (current && current.nodeType === 1) {
				var tag = current.tagName.toLowerCase();
				var parent = current.parentElement;
				if (!parent) { parts.unshift(tag); break; }
				var sameTag = Array.prototype.filter.call(parent.children, function(s) { return s.tagName === current.tagName; });
				if (sameTag.length > 1) {
					parts.unshift(tag + '[' + (Array.prototype.indexOf.call(sameTag, current) + 1) + ']');
				} else {
					parts.unshift(tag);
				}
				current = parent;
				if (parts.length >= 8) { truncated = true; break; }
			}
			return (truncated ? '//' : '/') + parts.join('/');
		}
		return { cssSelector: getCssSelector(el), xpath: getXPath(el) };
	})()`;
}

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

function getChromeLikeUserAgent(userAgent: string): string {
	return userAgent.replace(/\sElectron\/[^\s]+/g, "").trim();
}

class BrowserManager extends EventEmitter {
	private paneWebContentsIds = new Map<string, number>();
	/**
	 * Chromium CDP targetId for each pane's webview, captured once per
	 * register(). The browser-mcp bridge uses this to hand out a
	 * per-pane `ws://…/devtools/page/<targetId>` URL without probing
	 * `/json/list` on every tool call. Stable for the lifetime of the
	 * underlying webContents.
	 */
	private paneTargetIds = new Map<string, string>();
	/**
	 * Secondary per-pane CDP targetIds owned by "tabs" beyond the
	 * pane's primary webview. M2 multi-tab wiring populates these; M1
	 * leaves the map empty and the filter runs in single-target mode.
	 */
	private paneTabTargetIds = new Map<string, Set<string>>();
	private paneTabTargetIdByKey = new Map<string, string>();
	private paneTabWebContents = new Map<string, number>();
	private paneIdMarkerListeners = new Map<string, () => void>();
	private consoleLogs = new Map<string, ConsoleEntry[]>();
	private consoleListeners = new Map<string, () => void>();
	private contextMenuListeners = new Map<string, () => void>();
	private fullscreenListeners = new Map<string, () => void>();
	private popupListeners = new Map<string, () => void>();
	private findListeners = new Map<string, () => void>();
	/** Track which pane is currently in HTML fullscreen */
	private fullscreenPaneId: string | null = null;

	getFullscreenPaneId(): string | null {
		return this.fullscreenPaneId;
	}

	register(paneId: string, webContentsId: number): void {
		// Clean up previous listeners if re-registering with a new webContentsId
		const prevId = this.paneWebContentsIds.get(paneId);
		if (prevId != null && prevId !== webContentsId) {
			for (const map of [
				this.consoleListeners,
				this.contextMenuListeners,
				this.fullscreenListeners,
				this.popupListeners,
				this.findListeners,
			]) {
				const cleanup = map.get(paneId);
				if (cleanup) {
					cleanup();
					map.delete(paneId);
				}
			}
		}
		this.paneWebContentsIds.set(paneId, webContentsId);
		// Invalidate any stale targetId captured from a previous
		// webContents so /mcp/cdp-endpoint never returns a URL pointing
		// at a dead target while the async recapture is in flight.
		this.paneTargetIds.delete(paneId);
		const wc = webContents.fromId(webContentsId);
		if (wc) {
			// Keep throttling enabled so parked/offscreen persistent webviews don't
			// run at full speed in the background.
			wc.setBackgroundThrottling(true);
			wc.setWindowOpenHandler(({ url, disposition }) => {
				if (!url || url === "about:blank") {
					return { action: "deny" as const };
				}

				// window.open() calls (OAuth popups, auth flows, etc.) — allow as a
				// real child BrowserWindow so window.opener / postMessage work.
				if (disposition === "new-window") {
					return {
						action: "allow" as const,
						overrideBrowserWindowOptions: {
							width: 500,
							height: 700,
							autoHideMenuBar: true,
							backgroundColor: nativeTheme.shouldUseDarkColors
								? "#252525"
								: "#ffffff",
							webPreferences: {
								partition: "persist:superset",
							},
						},
					};
				}

				// Regular target="_blank" links — open as a new browser tab
				this.emit(`new-window:${paneId}`, url);
				this.emit("new-window", { paneId, url });
				return { action: "deny" as const };
			});
			this.setupPopupWindowHandler(paneId, wc);
			this.setupFullscreenHandler(paneId, wc);
			this.setupConsoleCapture(paneId, wc);
			this.setupContextMenu(paneId, wc);
			this.setupFindInPage(paneId, wc);
			this.setupPaneIdMarker(paneId, wc);
			void this.captureCdpTargetId(paneId, wc);
		}
	}

	unregister(paneId: string): void {
		for (const map of [
			this.consoleListeners,
			this.contextMenuListeners,
			this.fullscreenListeners,
			this.popupListeners,
			this.findListeners,
			this.paneIdMarkerListeners,
		]) {
			const cleanup = map.get(paneId);
			if (cleanup) {
				cleanup();
				map.delete(paneId);
			}
		}
		if (this.fullscreenPaneId === paneId) {
			this.fullscreenPaneId = null;
		}
		this.paneWebContentsIds.delete(paneId);
		this.paneTargetIds.delete(paneId);
		this.consoleLogs.delete(paneId);
	}

	unregisterAll(): void {
		for (const paneId of [...this.paneWebContentsIds.keys()]) {
			this.unregister(paneId);
		}
	}

	getWebContents(paneId: string): Electron.WebContents | null {
		const id = this.paneWebContentsIds.get(paneId);
		if (id == null) return null;
		const wc = webContents.fromId(id);
		if (!wc || wc.isDestroyed()) return null;
		return wc;
	}

	/**
	 * Chromium CDP targetId for the pane's webview, or null if we have
	 * not finished capturing it yet. The browser-mcp bridge uses this to
	 * hand external automation MCPs a per-pane ws://.../devtools/page/<id>
	 * URL.
	 */
	getCdpTargetId(paneId: string): string | null {
		return this.paneTargetIds.get(paneId) ?? null;
	}

	/**
	 * Return the full set of Chromium CDP targetIds that belong to a
	 * pane. For single-tab panes this is the singleton primary
	 * targetId; when multi-tab support is wired in M2 the registry
	 * will populate additional tab ids through addPaneTabTarget /
	 * removePaneTabTarget (see below). Returning undefined lets the
	 * gateway fall back to the primary-only path.
	 */
	getPaneTargetIds(paneId: string): Set<string> | undefined {
		const extras = this.paneTabTargetIds.get(paneId);
		const primary = this.paneTargetIds.get(paneId);
		if (!primary && !extras) return undefined;
		const set = new Set<string>();
		if (primary) set.add(primary);
		if (extras) for (const id of extras) set.add(id);
		return set;
	}

	addPaneTabTarget(paneId: string, targetId: string): void {
		let set = this.paneTabTargetIds.get(paneId);
		if (!set) {
			set = new Set<string>();
			this.paneTabTargetIds.set(paneId, set);
		}
		set.add(targetId);
		console.log(
			"[browser-manager] addPaneTabTarget",
			paneId,
			targetId,
			"now",
			Array.from(set),
		);
	}

	removePaneTabTarget(paneId: string, targetId: string): void {
		this.paneTabTargetIds.get(paneId)?.delete(targetId);
		console.log("[browser-manager] removePaneTabTarget", paneId, targetId);
	}

	listPanesWithCdpTargets(): Array<{ paneId: string; targetId: string }> {
		return Array.from(this.paneTargetIds.entries()).map(
			([paneId, targetId]) => ({ paneId, targetId }),
		);
	}

	/**
	 * Inject `window.__supersetPaneId = '<paneId>'` into every top frame
	 * of this pane, including after navigation. External CDP clients
	 * (chrome-devtools-mcp etc.) that enumerate /json/list use this as
	 * the ground-truth pane identifier via Runtime.evaluate.
	 */
	private setupPaneIdMarker(paneId: string, wc: Electron.WebContents): void {
		const literal = JSON.stringify(paneId);
		const inject = (): void => {
			if (wc.isDestroyed()) return;
			// executeJavaScript returns a promise we don't need to await.
			void wc
				.executeJavaScript(`window.__supersetPaneId = ${literal};`, false)
				.catch(() => {
					/* Pages like about:blank or in the middle of a redirect
					   can reject — retry on the next did-navigate. */
				});
		};
		wc.on("did-navigate", inject);
		wc.on("did-navigate-in-page", inject);
		wc.on("did-finish-load", inject);
		inject();
		this.paneIdMarkerListeners.set(paneId, () => {
			wc.off("did-navigate", inject);
			wc.off("did-navigate-in-page", inject);
			wc.off("did-finish-load", inject);
		});
	}

	/**
	 * Briefly attach the Electron CDP debugger to this pane so we can
	 * read `Target.getTargetInfo` and remember the Chromium-assigned
	 * targetId. Detach right after so we do not conflict with external
	 * CDP clients the user wires up later.
	 */
	private async captureCdpTargetId(
		paneId: string,
		wc: Electron.WebContents,
	): Promise<void> {
		if (wc.isDestroyed()) return;
		const expectedWebContentsId = wc.id;
		let attachedHere = false;
		try {
			if (!wc.debugger.isAttached()) {
				wc.debugger.attach("1.3");
				attachedHere = true;
			}
			const info = (await wc.debugger.sendCommand("Target.getTargetInfo")) as {
				targetInfo?: { targetId?: string };
			};
			const targetId = info?.targetInfo?.targetId;
			// Late-resolution guard: if the pane was unregistered or
			// re-registered with a different webContents while we were
			// awaiting, do not overwrite the current cache with stale data.
			const currentId = this.paneWebContentsIds.get(paneId);
			if (
				typeof targetId === "string" &&
				targetId.length > 0 &&
				currentId === expectedWebContentsId
			) {
				const previous = this.paneTargetIds.get(paneId);
				this.paneTargetIds.set(paneId, targetId);
				console.log(
					"[browser-manager] captured primary targetId pane",
					paneId,
					"wc",
					expectedWebContentsId,
					"targetId",
					targetId,
					"previous",
					previous,
				);
			} else {
				console.log(
					"[browser-manager] discarded captured targetId pane",
					paneId,
					"expectedWc",
					expectedWebContentsId,
					"currentWc",
					currentId,
					"targetId",
					targetId,
				);
			}
		} catch (error) {
			console.warn(
				`[browser-manager] failed to capture CDP targetId for pane ${paneId}:`,
				error,
			);
		} finally {
			if (attachedHere) {
				try {
					wc.debugger.detach();
				} catch {
					/* already detached */
				}
			}
		}
	}

	/**
	 * Register a secondary tab webContents for a pane. Captures its
	 * CDP targetId and adds it to the pane's tab target set so the
	 * gateway exposes it via Target.getTargets / filter.
	 */
	async registerTab(
		paneId: string,
		tabId: string,
		webContentsId: number,
	): Promise<void> {
		const wc = webContents.fromId(webContentsId);
		if (!wc || wc.isDestroyed()) return;
		// Tabs are routinely off-screen while another tab is active.
		// External CDP MCPs (browser-use, chrome-devtools-mcp) need
		// the inactive tab's webContents to keep timers / network /
		// JS running so navigation doesn't stall waiting for visibility.
		try {
			wc.setBackgroundThrottling(false);
		} catch {
			/* best-effort */
		}
		this.paneTabWebContents.set(this.tabKey(paneId, tabId), webContentsId);
		let attached = false;
		try {
			if (!wc.debugger.isAttached()) {
				wc.debugger.attach("1.3");
				attached = true;
			}
			const info = (await wc.debugger.sendCommand("Target.getTargetInfo")) as {
				targetInfo?: { targetId?: string };
			};
			const targetId = info?.targetInfo?.targetId;
			if (typeof targetId === "string" && targetId.length > 0) {
				this.paneTabTargetIdByKey.set(this.tabKey(paneId, tabId), targetId);
				this.addPaneTabTarget(paneId, targetId);
			}
		} catch (error) {
			console.warn(
				`[browser-manager] failed to capture tab CDP targetId for pane ${paneId} tab ${tabId}:`,
				error,
			);
		} finally {
			if (attached) {
				try {
					wc.debugger.detach();
				} catch {
					/* ignore */
				}
			}
		}
	}

	unregisterTab(paneId: string, tabId: string): void {
		const key = this.tabKey(paneId, tabId);
		const targetId = this.paneTabTargetIdByKey.get(key);
		if (targetId) this.removePaneTabTarget(paneId, targetId);
		this.paneTabTargetIdByKey.delete(key);
		this.paneTabWebContents.delete(key);
	}

	private tabKey(paneId: string, tabId: string): string {
		return `${paneId}::${tabId}`;
	}

	getPaneIdForWebContents(webContentsId: number): string | null {
		for (const [paneId, registeredWebContentsId] of this.paneWebContentsIds) {
			if (registeredWebContentsId === webContentsId) {
				return paneId;
			}
		}

		return null;
	}

	navigate(paneId: string, url: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		wc.loadURL(sanitizeUrl(url));
	}

	async screenshot(paneId: string): Promise<string> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		const image = await wc.capturePage();
		try {
			clipboard.writeImage(image);
		} catch (error) {
			console.error("[browser-manager] clipboard.writeImage failed:", error);
		}
		return image.toPNG().toString("base64");
	}

	async evaluateJS(paneId: string, code: string): Promise<unknown> {
		const wc = this.getWebContents(paneId);
		if (!wc) throw new Error(`No webContents for pane ${paneId}`);
		return wc.executeJavaScript(code);
	}

	getConsoleLogs(paneId: string): ConsoleEntry[] {
		return this.consoleLogs.get(paneId) ?? [];
	}

	openDevTools(paneId: string): void {
		const wc = this.getWebContents(paneId);
		if (!wc) return;
		wc.openDevTools({ mode: "detach" });
	}

	findInPage(
		paneId: string,
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
	): number | null {
		const wc = this.getWebContents(paneId);
		if (!wc || !text) return null;
		return wc.findInPage(text, options);
	}

	stopFindInPage(
		paneId: string,
		action: "clearSelection" | "keepSelection" | "activateSelection",
	): void {
		const wc = this.getWebContents(paneId);
		if (!wc) return;
		wc.stopFindInPage(action);
	}

	/**
	 * Listen for native `found-in-page` results and for Cmd/Ctrl+F keypresses
	 * happening inside the webview. The renderer cannot see keydown events
	 * dispatched to the guest page, so we intercept them here via
	 * `before-input-event` and emit a request to open the find overlay.
	 */
	private setupFindInPage(paneId: string, wc: Electron.WebContents): void {
		const foundHandler = (_event: Electron.Event, result: Electron.Result) => {
			this.emit(`found-in-page:${paneId}`, {
				requestId: result.requestId,
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
				finalUpdate: result.finalUpdate,
			});
		};

		const inputHandler = (event: Electron.Event, input: Electron.Input) => {
			if (input.type !== "keyDown") return;
			const isFindKey =
				(input.meta || input.control) &&
				input.key.toLowerCase() === "f" &&
				!input.alt &&
				!input.shift;
			if (isFindKey) {
				event.preventDefault();
				this.emit(`find-requested:${paneId}`);
				return;
			}
			if (input.key === "Escape") {
				this.emit(`find-escape:${paneId}`);
			}
		};

		wc.on("found-in-page", foundHandler);
		wc.on("before-input-event", inputHandler);

		this.findListeners.set(paneId, () => {
			try {
				wc.off("found-in-page", foundHandler);
				wc.off("before-input-event", inputHandler);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	/**
	 * Configure child windows created by window.open() (OAuth popups etc.).
	 * The child BrowserWindow preserves window.opener so postMessage-based
	 * auth flows work correctly.
	 */
	private setupPopupWindowHandler(
		paneId: string,
		wc: Electron.WebContents,
	): void {
		const handler = (childWindow: BrowserWindow, { url }: { url: string }) => {
			const childWc = childWindow.webContents;

			// Strip Electron token from child window's User-Agent
			const originalUA = childWc.getUserAgent();
			childWc.setUserAgent(getChromeLikeUserAgent(originalUA));

			// If the popup navigates to about:blank or a javascript: URI, it likely
			// means the auth flow finished and the opener consumed the result.
			childWc.on("will-navigate", (_event, navUrl) => {
				if (navUrl === "about:blank") {
					childWindow.close();
				}
			});

			// Some OAuth flows close the popup themselves via window.close() in JS.
			// That is handled natively by Electron. We also handle the case where the
			// user manually closes the popup — nothing special is needed.

			console.log(`[browser-manager] Popup opened for pane ${paneId}: ${url}`);
		};

		wc.on("did-create-window", handler);
		this.popupListeners.set(paneId, () => {
			try {
				wc.off("did-create-window", handler);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	/**
	 * Track HTML5 fullscreen enter/leave on webview content (e.g. YouTube
	 * video fullscreen). The BrowserWindow also enters fullscreen natively
	 * (like Chrome). We emit events so the renderer can adjust its UI
	 * (hide sidebar/tabs when entering, restore when leaving).
	 */
	private setupFullscreenHandler(
		paneId: string,
		wc: Electron.WebContents,
	): void {
		const handleEnter = () => {
			this.fullscreenPaneId = paneId;
			this.emit("fullscreen-change", { paneId, isFullscreen: true });
		};

		const handleLeave = () => {
			if (this.fullscreenPaneId === paneId) {
				this.fullscreenPaneId = null;
			}
			this.emit("fullscreen-change", { paneId, isFullscreen: false });
		};

		wc.on("enter-html-full-screen", handleEnter);
		wc.on("leave-html-full-screen", handleLeave);

		this.fullscreenListeners.set(paneId, () => {
			try {
				wc.off("enter-html-full-screen", handleEnter);
				wc.off("leave-html-full-screen", handleLeave);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	private setupContextMenu(paneId: string, wc: Electron.WebContents): void {
		const handler = (
			_event: Electron.Event,
			params: Electron.ContextMenuParams,
		) => {
			const { linkURL, pageURL, selectionText, editFlags } = params;

			const menuItems: Electron.MenuItemConstructorOptions[] = [];

			if (linkURL) {
				menuItems.push(
					{
						label: "Open Link in Default Browser",
						click: () => shell.openExternal(linkURL),
					},
					{
						label: "Open Link as New Split",
						click: () =>
							this.emit(`context-menu-action:${paneId}`, {
								action: "open-in-split" as const,
								url: linkURL,
							}),
					},
					{
						label: "Copy Link Address",
						click: () => {
							try {
								clipboard.writeText(linkURL);
							} catch {
								// clipboard unavailable
							}
						},
					},
					{ type: "separator" },
				);
			}

			if (selectionText) {
				menuItems.push({
					label: "Copy",
					enabled: editFlags.canCopy,
					click: () => wc.copy(),
				});
			}

			if (editFlags.canPaste) {
				menuItems.push({
					label: "Paste",
					click: () => wc.paste(),
				});
			}

			if (editFlags.canSelectAll) {
				menuItems.push({
					label: "Select All",
					click: () => wc.selectAll(),
				});
			}

			if (selectionText || editFlags.canPaste || editFlags.canSelectAll) {
				menuItems.push({ type: "separator" });
			}

			menuItems.push(
				{
					label: "Back",
					enabled: wc.canGoBack(),
					click: () => wc.goBack(),
				},
				{
					label: "Forward",
					enabled: wc.canGoForward(),
					click: () => wc.goForward(),
				},
				{
					label: "Reload",
					click: () => wc.reload(),
				},
			);

			if (!linkURL) {
				menuItems.push(
					{ type: "separator" },
					{
						label: "Open Page in Default Browser",
						click: () => {
							if (pageURL && pageURL !== "about:blank") {
								shell.openExternal(pageURL);
							}
						},
						enabled: !!pageURL && pageURL !== "about:blank",
					},
					{
						label: "Copy Page URL",
						click: () => {
							if (pageURL) {
								try {
									clipboard.writeText(pageURL);
								} catch {
									// clipboard unavailable
								}
							}
						},
						enabled: !!pageURL && pageURL !== "about:blank",
					},
				);
			}

			menuItems.push(
				{ type: "separator" },
				{
					label: "Copy Element Selector",
					submenu: [
						{
							label: "CSS Selector",
							click: async () => {
								try {
									const result = (await wc.executeJavaScript(
										buildElementPathScript(params.x, params.y),
									)) as { cssSelector: string; xpath: string } | null;
									if (result?.cssSelector) {
										clipboard.writeText(result.cssSelector);
									}
								} catch {
									// page may not support elementFromPoint
								}
							},
						},
						{
							label: "XPath",
							click: async () => {
								try {
									const result = (await wc.executeJavaScript(
										buildElementPathScript(params.x, params.y),
									)) as { cssSelector: string; xpath: string } | null;
									if (result?.xpath) {
										clipboard.writeText(result.xpath);
									}
								} catch {
									// page may not support elementFromPoint
								}
							},
						},
					],
				},
				{
					label: "Inspect Element",
					click: () => wc.inspectElement(params.x, params.y),
				},
			);

			const menu = Menu.buildFromTemplate(menuItems);
			menu.popup();
		};

		wc.on("context-menu", handler);
		this.contextMenuListeners.set(paneId, () => {
			try {
				wc.off("context-menu", handler);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	private setupConsoleCapture(paneId: string, wc: Electron.WebContents): void {
		const LEVEL_MAP: Record<number, ConsoleEntry["level"]> = {
			0: "log",
			1: "warn",
			2: "error",
			3: "info",
		};

		const handler = (
			_event: Electron.Event,
			level: number,
			message: string,
		) => {
			const entries = this.consoleLogs.get(paneId) ?? [];
			entries.push({
				level: LEVEL_MAP[level] ?? "log",
				message,
				timestamp: Date.now(),
			});
			if (entries.length > MAX_CONSOLE_ENTRIES) {
				entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
			}
			this.consoleLogs.set(paneId, entries);
			this.emit(`console:${paneId}`, entries[entries.length - 1]);
		};

		wc.on("console-message", handler);
		this.consoleListeners.set(paneId, () => {
			try {
				wc.off("console-message", handler);
			} catch {
				// webContents may be destroyed
			}
		});
	}

	showContextMenuForWebContents(
		wc: Electron.WebContents,
		x: number,
		y: number,
	): void {
		const script = buildElementPathScript(x, y);
		const menuItems: Electron.MenuItemConstructorOptions[] = [
			{
				label: "Copy Element Selector",
				submenu: [
					{
						label: "CSS Selector",
						click: async () => {
							try {
								const result = (await wc.executeJavaScript(script)) as {
									cssSelector: string;
									xpath: string;
								} | null;
								if (result?.cssSelector) {
									clipboard.writeText(result.cssSelector);
								}
							} catch {
								// page may not support elementFromPoint
							}
						},
					},
					{
						label: "XPath",
						click: async () => {
							try {
								const result = (await wc.executeJavaScript(script)) as {
									cssSelector: string;
									xpath: string;
								} | null;
								if (result?.xpath) {
									clipboard.writeText(result.xpath);
								}
							} catch {
								// page may not support elementFromPoint
							}
						},
					},
				],
			},
			{ type: "separator" },
			{
				label: "Inspect Element",
				click: () => wc.inspectElement(x, y),
			},
		];
		const menu = Menu.buildFromTemplate(menuItems);
		menu.popup();
	}
}

export const browserManager = new BrowserManager();
