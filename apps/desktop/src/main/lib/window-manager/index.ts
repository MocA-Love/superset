import { join } from "node:path";
import { type BrowserWindow, ipcMain, nativeTheme } from "electron";
import { createWindow } from "lib/electron-app/factories/windows/create";
import { PLATFORM } from "shared/constants";
import { appState } from "../app-state";
import {
	applyVibrancy,
	DEFAULT_VIBRANCY_STATE,
	getInitialWindowOptions as getInitialVibrancyOptions,
} from "../vibrancy";

interface TearoffWindowOptions {
	windowId: string;
	screenX: number;
	screenY: number;
	width?: number;
	height?: number;
}

interface TearoffTabData {
	tab: unknown;
	panes: Record<string, unknown>;
	workspaceId: string;
}

interface PendingAuthToken {
	token: string;
	expiresAt: string;
}

type IpcHandler = {
	attachWindow: (window: BrowserWindow) => void;
	detachWindow: (window: BrowserWindow) => void;
};

export class WindowManager {
	private windows = new Map<string, BrowserWindow>();
	private ipcHandler: IpcHandler | null = null;
	private ipcRegistered = false;
	private pendingTearoffData = new Map<string, TearoffTabData>();
	private pendingAuthTokens = new Map<string, PendingAuthToken | null>();

	setIpcHandler(handler: IpcHandler): void {
		this.ipcHandler = handler;
		this.registerIpcHandlers();
	}

	private registerIpcHandlers(): void {
		if (this.ipcRegistered) return;
		this.ipcRegistered = true;

		// Synchronous IPC: preload fetches tearoff data before React starts
		ipcMain.on("get-tearoff-data", (event, windowId: string) => {
			const data = this.pendingTearoffData.get(windowId);
			if (data) this.pendingTearoffData.delete(windowId);
			event.returnValue = data ?? null;
		});

		// Synchronous IPC: preload fetches auth token for tearoff windows
		ipcMain.on("get-tearoff-auth-token", (event, windowId: string) => {
			const token = this.pendingAuthTokens.get(windowId);
			if (token !== undefined) this.pendingAuthTokens.delete(windowId);
			event.returnValue = token ?? null;
		});

		// Tearoff window closing: return all tabs to main window (single message)
		ipcMain.on(
			"tearoff-return-tabs",
			(
				_event,
				data: Array<{ tab: unknown; panes: Record<string, unknown> }>,
			) => {
				const mainWindow = this.getMain();
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send("tearoff-tab-returned", data);
				} else {
					console.warn(
						"[window-manager] Main window unavailable; returned tabs lost:",
						data.length,
					);
				}
			},
		);
	}

	setPendingTearoffData(windowId: string, data: TearoffTabData): void {
		this.pendingTearoffData.set(windowId, data);
		setTimeout(() => this.pendingTearoffData.delete(windowId), 30_000);
	}

	setPendingAuthToken(windowId: string, token: PendingAuthToken | null): void {
		this.pendingAuthTokens.set(windowId, token);
		setTimeout(() => this.pendingAuthTokens.delete(windowId), 30_000);
	}

	register(windowId: string, window: BrowserWindow): void {
		this.windows.set(windowId, window);
	}

	unregister(windowId: string): void {
		this.windows.delete(windowId);
	}

	get(windowId: string): BrowserWindow | null {
		return this.windows.get(windowId) ?? null;
	}

	getMain(): BrowserWindow | null {
		return this.windows.get("main") ?? null;
	}

	getAll(): Map<string, BrowserWindow> {
		return new Map(this.windows);
	}

	createTearoffWindow(options: TearoffWindowOptions): {
		windowId: string;
		window: BrowserWindow;
	} {
		const { windowId } = options;

		const initialVibrancyState =
			appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE;
		const vibrancyWindowOptions = getInitialVibrancyOptions(
			initialVibrancyState,
			nativeTheme.shouldUseDarkColors,
		);

		const window = createWindow({
			id: "tearoff",
			title: "Superset",
			width: options.width ?? 900,
			height: options.height ?? 600,
			x: Math.round(options.screenX - 100),
			y: Math.round(options.screenY - 20),
			minWidth: 400,
			minHeight: 400,
			show: false,
			...vibrancyWindowOptions,
			frame: false,
			titleBarStyle: "hidden",
			trafficLightPosition: { x: 16, y: 16 },
			webPreferences: {
				preload: join(__dirname, "../preload/index.js"),
				webviewTag: true,
				partition: "persist:superset",
				additionalArguments: [`--tearoff-window-id=${windowId}`],
			},
		});

		this.register(windowId, window);
		this.ipcHandler?.attachWindow(window);

		// Detach IPC BEFORE window is destroyed (close fires before closed)
		window.on("close", () => {
			this.ipcHandler?.detachWindow(window);
		});
		window.on("closed", () => {
			this.windows.delete(windowId);
		});

		// macOS Sequoia+: NSVisualEffectView can detach while the window is
		// minimized in the Dock — the tearoff needs the same reshow guard as
		// the main window or it restores opaque.
		if (PLATFORM.IS_MAC) {
			const reapplyVibrancyOnReshow = () => {
				if (window.isDestroyed()) return;
				applyVibrancy(
					window,
					appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE,
					nativeTheme.shouldUseDarkColors,
				);
			};
			window.on("restore", reapplyVibrancyOnReshow);
			window.on("show", reapplyVibrancyOnReshow);
		}

		window.webContents.once("did-finish-load", () => {
			// Re-apply vibrancy now that the tearoff is on-screen so the
			// native blur addon can find the NSVisualEffectView and write
			// the user's persisted blurRadius. Without this the tearoff
			// would stick to the default material blur until the user
			// touched the vibrancy settings again.
			applyVibrancy(
				window,
				appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE,
				nativeTheme.shouldUseDarkColors,
			);
			window.show();
		});

		return { windowId, window };
	}

	broadcast(channel: string, ...args: unknown[]): void {
		for (const window of this.windows.values()) {
			if (!window.isDestroyed()) {
				window.webContents.send(channel, ...args);
			}
		}
	}
}

export const windowManager = new WindowManager();
