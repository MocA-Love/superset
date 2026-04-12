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
			]) {
				const cleanup = map.get(paneId);
				if (cleanup) {
					cleanup();
					map.delete(paneId);
				}
			}
		}
		this.paneWebContentsIds.set(paneId, webContentsId);
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
		}
	}

	unregister(paneId: string): void {
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
		if (this.fullscreenPaneId === paneId) {
			this.fullscreenPaneId = null;
		}
		this.paneWebContentsIds.delete(paneId);
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
}

export const browserManager = new BrowserManager();
