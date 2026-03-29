import path from "node:path";
import { BrowserWindow, nativeTheme, screen, session } from "electron";
import { getExtensionsDir } from "./crx-downloader";

const APP_PARTITION = "persist:superset";

/** Max popup dimensions */
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const MIN_SIZE = 25;

/** Gap between anchor icon and popup */
const ANCHOR_GAP = 4;

interface AnchorRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Manages the lifecycle of extension popup BrowserWindows.
 *
 * Only one popup can be open at a time. Opening a new popup automatically
 * closes the previous one.
 */
export class ExtensionPopupManager {
	private currentPopup: BrowserWindow | null = null;

	/**
	 * Open an extension popup window anchored below a toolbar icon.
	 *
	 * @param parentWindow  The main BrowserWindow (used as parent)
	 * @param extensionId   Extension ID for the chrome-extension:// URL
	 * @param popupPath     Relative path to the popup HTML (e.g. "popup.html")
	 * @param anchorRect    Bounding rect of the icon *relative to the parent window content area*
	 */
	openPopup(
		parentWindow: BrowserWindow,
		extensionId: string,
		popupPath: string,
		anchorRect: AnchorRect,
	): void {
		// Close any existing popup
		this.closePopup();

		// Convert content-relative coordinates to screen coordinates
		const contentBounds = parentWindow.getContentBounds();

		const screenAnchor = {
			x: contentBounds.x + anchorRect.x,
			y: contentBounds.y + anchorRect.y,
			width: anchorRect.width,
			height: anchorRect.height,
		};

		// Initial position: centered below the anchor
		const initialWidth = 350;
		const initialHeight = 400;
		let popupX =
			screenAnchor.x +
			Math.round(screenAnchor.width / 2) -
			Math.round(initialWidth / 2);
		let popupY = screenAnchor.y + screenAnchor.height + ANCHOR_GAP;

		// Clamp to the display bounds
		const display = screen.getDisplayNearestPoint({
			x: screenAnchor.x,
			y: screenAnchor.y,
		});
		const workArea = display.workArea;

		if (popupX + initialWidth > workArea.x + workArea.width) {
			popupX = workArea.x + workArea.width - initialWidth;
		}
		if (popupX < workArea.x) {
			popupX = workArea.x;
		}

		// If not enough space below, show above the anchor
		if (popupY + initialHeight > workArea.y + workArea.height) {
			popupY = screenAnchor.y - initialHeight - ANCHOR_GAP;
		}
		if (popupY < workArea.y) {
			popupY = workArea.y;
		}

		const popup = new BrowserWindow({
			parent: parentWindow,
			modal: false,
			show: false,
			frame: false,
			transparent: false,
			backgroundColor: nativeTheme.shouldUseDarkColors
				? "#252525"
				: "#ffffff",
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			width: initialWidth,
			height: initialHeight,
			x: popupX,
			y: popupY,
			webPreferences: {
				session: session.fromPartition(APP_PARTITION),
				nodeIntegration: false,
				contextIsolation: true,
				// sandbox must be false — sandboxed renderers cannot load
				// chrome-extension:// URLs (ERR_BLOCKED_BY_CLIENT)
				sandbox: false,
				enablePreferredSizeMode: true,
			},
		});

		this.currentPopup = popup;

		// Auto-resize when popup content changes size
		popup.webContents.on("preferred-size-changed", (_event, preferredSize) => {
			if (popup.isDestroyed()) return;

			const width = Math.min(MAX_WIDTH, Math.max(MIN_SIZE, preferredSize.width));
			const height = Math.min(
				MAX_HEIGHT,
				Math.max(MIN_SIZE, preferredSize.height),
			);

			// Re-center horizontally relative to anchor
			let newX =
				screenAnchor.x +
				Math.round(screenAnchor.width / 2) -
				Math.round(width / 2);

			// Clamp to work area
			if (newX + width > workArea.x + workArea.width) {
				newX = workArea.x + workArea.width - width;
			}
			if (newX < workArea.x) {
				newX = workArea.x;
			}

			popup.setBounds({
				x: newX,
				y: popupY,
				width,
				height,
			});
		});

		// Show after the page loads to avoid flicker
		popup.webContents.on("did-finish-load", () => {
			if (!popup.isDestroyed()) {
				popup.show();
				popup.focus();
			}
		});

		// Close when the popup loses focus
		popup.on("blur", () => {
			if (popup.isDestroyed()) return;
			// Don't close if devtools is open (for debugging)
			if (popup.webContents.isDevToolsOpened()) return;
			this.closePopup();
		});

		popup.on("closed", () => {
			if (this.currentPopup === popup) {
				this.currentPopup = null;
			}
		});

		// Load the extension's popup page.
		// Try chrome-extension:// first (enables full chrome.* API access).
		// Fall back to loading from the local file path if blocked.
		const popupUrl = `chrome-extension://${extensionId}/${popupPath}`;
		popup.webContents.loadURL(popupUrl).catch((error) => {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(
				`[extensions] chrome-extension:// load failed for ${extensionId}, trying file:// fallback:`,
				msg,
			);

			// Fallback: load the popup HTML directly from disk
			const filePath = path.join(
				getExtensionsDir(),
				extensionId,
				popupPath,
			);
			popup.webContents.loadFile(filePath).catch((fileError) => {
				console.error(
					`[extensions] Failed to load popup for ${extensionId}:`,
					fileError,
				);
				this.closePopup();
			});
		});
	}

	closePopup(): void {
		if (this.currentPopup && !this.currentPopup.isDestroyed()) {
			this.currentPopup.destroy();
		}
		this.currentPopup = null;
	}

	isOpen(): boolean {
		return this.currentPopup !== null && !this.currentPopup.isDestroyed();
	}
}

/** Singleton instance */
export const extensionPopupManager = new ExtensionPopupManager();
