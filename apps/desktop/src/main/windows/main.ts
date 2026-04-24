import type { Server } from "node:http";
import { join } from "node:path";
import * as Sentry from "@sentry/electron/main";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import type { BrowserWindow } from "electron";
import { app, Notification, nativeTheme, webContents } from "electron";
import { createWindow } from "lib/electron-app/factories/windows/create";
import { createAppRouter } from "lib/trpc/routers";
import { localDb } from "main/lib/local-db";
import { NOTIFICATION_EVENTS, PLATFORM } from "shared/constants";
import {
	env,
	getWorkspaceName as getEnvWorkspaceName,
} from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { createIPCHandler } from "trpc-electron/main";
import { productName } from "~/package.json";
import {
	handleAgentLifecycleForWindowsSleep,
	handleTerminalExitForWindowsSleep,
} from "../lib/agent-sleep/windows-sleep-blocker";
import { appState } from "../lib/app-state";
import { browserManager } from "../lib/browser/browser-manager";
import { createApplicationMenu } from "../lib/menu";
import { playNotificationSound } from "../lib/notification-sound";
import { playAivisNotification } from "../lib/notifications/aivis-tts";
import { NotificationManager } from "../lib/notifications/notification-manager";
import {
	notificationsApp,
	notificationsEmitter,
} from "../lib/notifications/server";
import {
	extractWorkspaceIdFromUrl,
	getNotificationTitle,
	getWorkspaceName,
} from "../lib/notifications/utils";
import {
	applyVibrancy,
	DEFAULT_VIBRANCY_STATE,
	getInitialWindowOptions as getInitialVibrancyOptions,
} from "../lib/vibrancy";
import { windowManager } from "../lib/window-manager";
import {
	getInitialWindowBounds,
	isWindowPositionPersistenceEnabled,
	loadWindowState,
	saveWindowState,
} from "../lib/window-state";
import { getWorkspaceRuntimeRegistry } from "../lib/workspace-runtime";

// Singleton IPC handler to prevent duplicate handlers on window reopen (macOS)
let ipcHandler: ReturnType<typeof createIPCHandler> | null = null;

function getWorkspaceRecords(workspaceId: string | undefined) {
	if (!workspaceId) return { workspace: null, worktree: null, project: null };
	try {
		const workspace =
			localDb
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get() ?? null;
		const worktree = workspace?.worktreeId
			? (localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.id, workspace.worktreeId))
					.get() ?? null)
			: null;
		const project = workspace?.projectId
			? (localDb
					.select()
					.from(projects)
					.where(eq(projects.id, workspace.projectId))
					.get() ?? null)
			: null;
		return { workspace, worktree, project };
	} catch (error) {
		console.error("[notifications] Failed to read workspace records:", error);
		return { workspace: null, worktree: null, project: null };
	}
}

function getWorkspaceNameFromDb(workspaceId: string | undefined): string {
	const { workspace, worktree } = getWorkspaceRecords(workspaceId);
	return getWorkspaceName({ workspace, worktree });
}

function buildAivisVars(event: AgentLifecycleEvent) {
	const { workspace, worktree, project } = getWorkspaceRecords(
		event.workspaceId,
	);
	const tabs = appState.data?.tabsState?.tabs;
	const panes = appState.data?.tabsState?.panes;
	const tab = event.tabId ? tabs?.find((t) => t.id === event.tabId) : undefined;
	const pane = event.paneId ? panes?.[event.paneId] : undefined;
	const branch = workspace?.branch ?? worktree?.branch ?? "";
	const worktreeName = worktree?.branch ?? "";
	return {
		branch,
		workspace: workspace?.name || branch || "",
		worktree: worktreeName,
		project: project?.name ?? "",
		tab: (tab?.userTitle?.trim() || tab?.name) ?? "",
		pane: pane?.name ?? "",
		event: event.eventType,
	};
}

let currentWindow: BrowserWindow | null = null;
let mainWindowCleanup: (() => void) | null = null;
let notificationsInitialized = false;
let notificationsServer: Server | null = null;
let notificationManager: NotificationManager | null = null;
let agentLifecycleListener: ((event: AgentLifecycleEvent) => void) | null =
	null;
let terminalExitListener:
	| ((event: {
			paneId: string;
			exitCode: number;
			signal?: number;
			reason?: "killed" | "exited" | "error";
	  }) => void)
	| null = null;

/** Tear down main window resources (notification server, IPC, etc.)
 *  without destroying the BrowserWindow itself. Called from before-quit
 *  tray-stay-alive path where win.destroy() skips close events. */
export function cleanupMainWindowResources(): void {
	mainWindowCleanup?.();
	mainWindowCleanup = null;
	cleanupNotifications();
}

function addWindowLifecycleBreadcrumb(
	message: string,
	data?: Record<string, string | number | boolean | undefined>,
): void {
	Sentry.addBreadcrumb({
		category: "window.lifecycle",
		level: "info",
		message,
		data,
	});
}

// Routers receive this getter so they always see the current window, not a stale reference
const getWindow = () => currentWindow;

// invalidate() alone may not rebuild corrupted GPU layers — a tiny resize
// forces Chromium to reconstruct the compositor layer tree.
const forceRepaint = (win: BrowserWindow) => {
	if (win.isDestroyed()) return;
	win.webContents.invalidate();
	if (win.isFullScreen()) {
		win.setFullScreen(false);
		setTimeout(() => {
			if (!win.isDestroyed()) win.setFullScreen(true);
		}, 100);
	} else if (win.isMaximized()) {
		win.unmaximize();
		setTimeout(() => {
			if (!win.isDestroyed()) win.maximize();
		}, 100);
	} else {
		const [width, height] = win.getSize();
		win.setSize(width + 1, height);
		setTimeout(() => {
			if (!win.isDestroyed()) win.setSize(width, height);
		}, 32);
	}
};

// GPU process restarts don't repaint existing compositor layers automatically.
app.on("child-process-gone", (_event, details) => {
	if (details.type === "GPU") {
		console.warn("[main-window] GPU process gone:", details.reason);
		const win = getWindow();
		if (win) forceRepaint(win);
	}
});

// Re-apply vibrancy when the OS dark/light appearance changes. The
// computed setBackgroundColor depends on isDark so the window would
// otherwise keep the previous tint until the user interacted with the
// vibrancy settings again. Only relevant on macOS, but nativeTheme is
// harmless to subscribe to on other platforms.
nativeTheme.on("updated", () => {
	const isDark = nativeTheme.shouldUseDarkColors;
	const vibrancyState = appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE;
	for (const win of windowManager.getAll().values()) {
		applyVibrancy(win, vibrancyState, isDark);
	}
});

export function initNotifications(): void {
	if (notificationsInitialized) return;

	notificationManager = new NotificationManager({
		isSupported: () => Notification.isSupported(),
		createNotification: (opts) => new Notification(opts),
		playSound: playNotificationSound,
		playAivis: (event) => {
			const kind =
				event.eventType === "PermissionRequest" ? "permission" : "complete";
			void playAivisNotification(kind, buildAivisVars(event));
		},
		onNotificationClick: (ids) => {
			const window = getWindow();
			if (window && !window.isDestroyed()) {
				window.show();
				window.focus();
			} else {
				app.emit("activate");
			}
			notificationsEmitter.emit(NOTIFICATION_EVENTS.FOCUS_TAB, ids);
		},
		getVisibilityContext: () => {
			const window = getWindow();
			const windowIsReady = window && !window.isDestroyed();
			return {
				isFocused: windowIsReady ? window.isFocused() : false,
				currentWorkspaceId: windowIsReady
					? extractWorkspaceIdFromUrl(window.webContents.getURL())
					: null,
				tabsState: appState.data?.tabsState,
			};
		},
		getWorkspaceName: getWorkspaceNameFromDb,
		getNotificationTitle: (event) =>
			getNotificationTitle({
				tabId: event.tabId,
				paneId: event.paneId,
				tabs: appState.data?.tabsState?.tabs,
				panes: appState.data?.tabsState?.panes,
			}),
	});
	notificationManager.start();

	agentLifecycleListener = (event: AgentLifecycleEvent) => {
		handleAgentLifecycleForWindowsSleep(event);
		notificationManager?.handleAgentLifecycle(event);
	};
	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		agentLifecycleListener,
	);

	terminalExitListener = (event) => {
		notificationsEmitter.emit(NOTIFICATION_EVENTS.TERMINAL_EXIT, {
			paneId: event.paneId,
			exitCode: event.exitCode,
			signal: event.signal,
			reason: event.reason,
		});
		// Release any Windows powerSaveBlocker that was held for agent activity
		// in this pane — terminal exit means no more agent events will arrive.
		handleTerminalExitForWindowsSleep(event.paneId);
	};
	getWorkspaceRuntimeRegistry()
		.getDefault()
		.terminal.on("terminalExit", terminalExitListener);

	notificationsServer = notificationsApp.listen(
		env.DESKTOP_NOTIFICATIONS_PORT,
		"127.0.0.1",
		() => {
			console.log(
				`[notifications] Listening on http://127.0.0.1:${env.DESKTOP_NOTIFICATIONS_PORT}`,
			);
		},
	);

	notificationsInitialized = true;
}

function cleanupNotifications(): void {
	if (!notificationsInitialized) return;

	if (agentLifecycleListener) {
		notificationsEmitter.off(
			NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
			agentLifecycleListener,
		);
		agentLifecycleListener = null;
	}

	if (terminalExitListener) {
		getWorkspaceRuntimeRegistry()
			.getDefault()
			.terminal.off("terminalExit", terminalExitListener);
		terminalExitListener = null;
	}

	notificationManager?.dispose();
	notificationManager = null;

	notificationsServer?.close();
	notificationsServer = null;

	notificationsInitialized = false;
}

export async function MainWindow() {
	const shouldPersistWindowPosition = isWindowPositionPersistenceEnabled();
	const savedWindowState = loadWindowState();
	const initialBounds = getInitialWindowBounds(savedWindowState, {
		restorePosition: shouldPersistWindowPosition,
	});
	let persistedZoomLevel = savedWindowState?.zoomLevel;

	const isDev = env.NODE_ENV === "development";
	const workspaceName = isDev ? getEnvWorkspaceName() : undefined;
	const windowTitle = workspaceName
		? `${productName} — ${workspaceName}`
		: productName;

	const initialVibrancyState =
		appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE;
	const vibrancyWindowOptions = getInitialVibrancyOptions(
		initialVibrancyState,
		nativeTheme.shouldUseDarkColors,
	);

	const window = createWindow({
		id: "main",
		title: windowTitle,
		width: initialBounds.width,
		height: initialBounds.height,
		x: initialBounds.x,
		y: initialBounds.y,
		minWidth: 400,
		minHeight: 400,
		show: false,
		...vibrancyWindowOptions,
		center: initialBounds.center,
		movable: true,
		resizable: true,
		alwaysOnTop: false,
		autoHideMenuBar: true,
		frame: false,
		titleBarStyle: "hidden",
		// Windows has no traffic-light controls; use the Electron overlay so the
		// built-in minimize/maximize/close buttons render on top of the custom
		// title bar. macOS keeps the familiar red/yellow/green indent.
		...(PLATFORM.IS_WINDOWS
			? {
					titleBarOverlay: {
						color: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
						symbolColor: nativeTheme.shouldUseDarkColors
							? "#ffffff"
							: "#000000",
						height: 35,
					},
				}
			: { trafficLightPosition: { x: 16, y: 16 } }),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			webviewTag: true,
			// Isolate Electron session from system browser cookies
			// This ensures desktop uses bearer token auth, not web cookies
			partition: "persist:superset",
		},
	});

	createApplicationMenu();

	currentWindow = window;
	windowManager.register("main", window);

	// macOS Sequoia+: background throttling can corrupt GPU compositor layers
	if (PLATFORM.IS_MAC) {
		window.webContents.setBackgroundThrottling(false);
	}

	// Windows: forward renderer warnings/errors to the main process stdout so
	// black-screen-style startup failures show up in the Electron log rather
	// than being trapped inside the DevTools that the user cannot open.
	if (PLATFORM.IS_WINDOWS) {
		window.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				if (level < 2) return;
				const levelStr =
					["verbose", "info", "warning", "error"][level] ?? "unknown";
				const source = sourceId ? ` (${sourceId}:${line})` : "";
				const formatted = `[renderer:${levelStr}] ${message}${source}`;
				if (level === 3) console.error(formatted);
				else console.warn(formatted);
			},
		);

		// Keep the title-bar overlay contrast aligned with the OS theme — it is
		// a Windows-only API so the call is safely gated.
		nativeTheme.on("updated", () => {
			if (window.isDestroyed()) return;
			window.setTitleBarOverlay?.({
				color: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
				symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#000000",
				height: 35,
			});
		});
	}

	if (ipcHandler) {
		ipcHandler.attachWindow(window);
	} else {
		ipcHandler = createIPCHandler({
			router: createAppRouter(getWindow, windowManager),
			windows: [window],
		});
		windowManager.setIpcHandler(ipcHandler);
	}

	// macOS Sequoia+: occluded/minimized windows can lose compositor layers,
	// and NSVisualEffectView's vibrancy/native blur can detach while the
	// window is in the Dock — restoring without re-applying leaves the
	// window opaque even though the user still has vibrancy enabled.
	if (PLATFORM.IS_MAC) {
		const reapplyVibrancyOnReshow = () => {
			if (window.isDestroyed()) return;
			applyVibrancy(
				window,
				appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE,
				nativeTheme.shouldUseDarkColors,
			);
		};
		window.on("restore", () => {
			addWindowLifecycleBreadcrumb("main window restored");
			window.webContents.invalidate();
			reapplyVibrancyOnReshow();
		});
		window.on("show", () => {
			addWindowLifecycleBreadcrumb("main window shown");
			window.webContents.invalidate();
			reapplyVibrancyOnReshow();
		});
	}

	// Persist window bounds on move/resize so state survives app.exit(0)
	// (which skips the close handler — e.g. electron-vite SIGTERM during dev).
	// Gated by `initialized` so the initial maximize() doesn't immediately
	// write isMaximized: true back to disk before the user touches the window.
	let initialized = false;
	let hasCompletedFirstLoad = false;
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;

	const getWindowStateSnapshot = () => {
		const isMaximized = window.isMaximized();
		const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
		const zoomLevel = window.webContents.getZoomLevel();
		return {
			x: shouldPersistWindowPosition ? bounds.x : 0,
			y: shouldPersistWindowPosition ? bounds.y : 0,
			width: bounds.width,
			height: bounds.height,
			isMaximized,
			zoomLevel,
		};
	};

	const debouncedSave = () => {
		if (!initialized || window.isDestroyed()) return;
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			if (window.isDestroyed()) return;
			const state = getWindowStateSnapshot();
			saveWindowState(state);
			persistedZoomLevel = state.zoomLevel;
		}, 500);
	};
	if (shouldPersistWindowPosition) {
		window.on("move", debouncedSave);
	}
	window.on("resize", debouncedSave);
	window.webContents.on("zoom-changed", () => {
		setTimeout(() => {
			if (window.isDestroyed()) return;
			persistedZoomLevel = window.webContents.getZoomLevel();
			debouncedSave();
		}, 0);
	});

	window.webContents.on("did-finish-load", () => {
		console.log("[main-window] Renderer loaded successfully");

		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}

		// Re-apply vibrancy now that the window is actually on-screen so the
		// native CIGaussianBlur addon has a real NSVisualEffectView to mutate.
		applyVibrancy(
			window,
			appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE,
			nativeTheme.shouldUseDarkColors,
		);

		if (!hasCompletedFirstLoad) {
			if (initialBounds.isMaximized) {
				window.maximize();
			}
			window.show();
			initialized = true;
			hasCompletedFirstLoad = true;
		}
	});

	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("[main-window] Failed to load renderer:");
			console.error(`  Error code: ${errorCode}`);
			console.error(`  Description: ${errorDescription}`);
			console.error(`  URL: ${validatedURL}`);
			// Show the window anyway so user can see something is wrong
			window.show();
		},
	);

	window.webContents.on("render-process-gone", (_event, details) => {
		addWindowLifecycleBreadcrumb("renderer process gone", {
			reason: details.reason,
			exitCode: details.exitCode,
		});
		console.error("[main-window] Renderer process gone:", details);
		if (window.isDestroyed()) return;

		if (details.reason === "oom") {
			app.relaunch();
			app.exit(0);
		} else if (details.reason !== "clean-exit") {
			window.webContents.reload();
		}
	});

	window.webContents.on("preload-error", (_event, preloadPath, error) => {
		console.error("[main-window] Preload script error:");
		console.error(`  Path: ${preloadPath}`);
		console.error(`  Error:`, error);
	});

	// Handle mouse back/forward buttons for webview panes (Windows/Linux).
	// `app-command` is not supported on macOS; macOS mouse buttons are handled
	// via executeJavaScript injection in usePersistentWebview's dom-ready handler.
	window.on("app-command", (_event, command) => {
		const focusedGuest = webContents
			.getAllWebContents()
			.find((wc) => wc.getType() === "webview" && wc.isFocused());
		if (!focusedGuest) return;

		if (command === "browser-backward") {
			focusedGuest.navigationHistory.goBack();
		} else if (command === "browser-forward") {
			focusedGuest.navigationHistory.goForward();
		}
	});

	window.on("close", (event) => {
		addWindowLifecycleBreadcrumb("main window closing", {
			isDestroyed: window.isDestroyed(),
			isVisible: window.isVisible(),
		});
		// Save window state first, before any cleanup
		const state = getWindowStateSnapshot();
		saveWindowState(state);
		persistedZoomLevel = state.zoomLevel;

		// macOS: hide instead of destroy so "Open Superset" can reshow instantly.
		// The quit flow uses app.exit(0) which bypasses close events entirely,
		// so this hide path only runs for Cmd+W / red-X.
		if (PLATFORM.IS_MAC) {
			event.preventDefault();
			window.hide();
			return;
		}

		doCleanup();
	});

	function doCleanup() {
		browserManager.unregisterAll();
		ipcHandler?.detachWindow(window);
		windowManager.unregister("main");
		currentWindow = null;
		mainWindowCleanup = null;
	}

	mainWindowCleanup = doCleanup;

	return window;
}
