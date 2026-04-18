import path from "node:path";
import { pathToFileURL } from "node:url";
import { projects, settings, workspaces } from "@superset/local-db";
import { desc, eq, isNull } from "drizzle-orm";
import {
	app,
	BrowserWindow,
	dialog,
	Notification,
	net,
	protocol,
	session,
} from "electron";
import { makeAppSetup } from "lib/electron-app/factories/app/setup";
import {
	handleAuthCallback,
	loadToken,
	parseAuthDeepLink,
} from "lib/trpc/routers/auth/utils/auth-functions";
import { fetchGitHubOwner } from "lib/trpc/routers/projects/utils/github";
import { applyShellEnvToProcess } from "lib/trpc/routers/workspaces/utils/shell-env";
import { env as mainEnv } from "main/env.main";
import {
	DEFAULT_CONFIRM_ON_QUIT,
	PLATFORM,
	PROTOCOL_SCHEME,
} from "shared/constants";
import { setupAgentHooks } from "./lib/agent-setup";
import { initAppState } from "./lib/app-state";
import { requestAppleEventsAccess } from "./lib/apple-events-permission";
import { setupAutoUpdater } from "./lib/auto-updater";
import { initializeBrowserIdentityManager } from "./lib/browser/browser-identity-manager";
import { browserSitePermissionManager } from "./lib/browser/browser-site-permission-manager";
import { initializeBrowserWebviewCompat } from "./lib/browser/browser-webview-compat";
import { resolveDevWorkspaceName } from "./lib/dev-workspace-name";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { createExtensionIconProtocolHandler } from "./lib/extensions/extension-icon-protocol";
import { loadInstalledExtensions } from "./lib/extensions/extension-manager";
// FORK NOTE: upstream renamed host-service-manager → host-service-coordinator (#3250 relay)
// Aliased as getHostServiceManager to minimize diff with fork's quit lifecycle code
import { getHostServiceCoordinator as getHostServiceManager } from "./lib/host-service-coordinator";
import { closeLocalDb, localDb } from "./lib/local-db";
import { ensureProjectIconsDir, getProjectIconPath } from "./lib/project-icons";
import { initSentry } from "./lib/sentry";
import { setupServiceStatusPolling } from "./lib/service-status";
import { createTempAudioProtocolHandler } from "./lib/temp-audio-protocol";
import { createWorkspaceMediaProtocolHandler } from "./lib/workspace-media-protocol";
import {
	prewarmTerminalRuntime,
	reconcileDaemonSessions,
} from "./lib/terminal";
import { disposeTray, initTray } from "./lib/tray";
import { windowManager } from "./lib/window-manager";

// Lazy import to avoid module resolution issues during Vite build
const loadVscodeShim = () =>
	import("./lib/vscode-shim") as Promise<typeof import("./lib/vscode-shim")>;

import { cleanupMainWindowResources, MainWindow } from "./windows/main";

console.log("[main] Local database ready:", !!localDb);
const IS_DEV = process.env.NODE_ENV === "development";

void applyShellEnvToProcess().catch((error) => {
	console.error("[main] Failed to apply shell environment:", error);
});

// Dev mode: label the app with the workspace name so multiple worktrees are distinguishable
if (IS_DEV) {
	const workspaceName = resolveDevWorkspaceName();
	if (workspaceName) {
		app.setName(`Superset (${workspaceName})`);
	}
}

// Dev mode: register with execPath + app script so macOS launches Electron with our entry point
if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

function normalizeRepoValue(
	value: string,
): { owner: string | null; repo: string } | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	let candidate = trimmed.replace(/\.git$/i, "");

	if (/^https?:\/\//i.test(candidate)) {
		try {
			const url = new URL(candidate);
			candidate = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
		} catch {
			return null;
		}
	}

	candidate = candidate.replace(/^github\.com[/:]/i, "");
	const parts = candidate
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length >= 2) {
		return {
			owner: parts[parts.length - 2].toLowerCase(),
			repo: parts[parts.length - 1].toLowerCase(),
		};
	}

	if (parts.length === 1) {
		return {
			owner: null,
			repo: parts[0].toLowerCase(),
		};
	}

	return null;
}

function normalizeOptionalPositiveInt(value: string | null): string | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return String(parsed);
}

async function resolveWorkspaceOpenRouteFromDeepLink(
	url: URL,
): Promise<string | null> {
	const repoParam = url.searchParams.get("repo");
	const fileParam = url.searchParams.get("file");
	const branchParam = url.searchParams.get("branch")?.trim() || null;
	const normalizedRepo = repoParam ? normalizeRepoValue(repoParam) : null;

	if (!normalizedRepo) {
		return null;
	}

	const candidates = localDb
		.select({
			workspaceId: workspaces.id,
			workspaceBranch: workspaces.branch,
			lastOpenedAt: workspaces.lastOpenedAt,
			projectGithubOwner: projects.githubOwner,
			projectId: projects.id,
			projectMainRepoPath: projects.mainRepoPath,
		})
		.from(workspaces)
		.innerJoin(projects, eq(workspaces.projectId, projects.id))
		.where(isNull(workspaces.deletingAt))
		.orderBy(desc(workspaces.lastOpenedAt))
		.all();
	const candidatesWithOwner = await Promise.all(
		candidates.map(async (row) => {
			if (row.projectGithubOwner) {
				return row;
			}

			const projectGithubOwner = await fetchGitHubOwner(
				row.projectMainRepoPath,
			);
			if (!projectGithubOwner) {
				return row;
			}

			localDb
				.update(projects)
				.set({ githubOwner: projectGithubOwner })
				.where(eq(projects.id, row.projectId))
				.run();

			return {
				...row,
				projectGithubOwner,
			};
		}),
	);
	const filteredCandidates = candidatesWithOwner.filter((row) => {
		const repoName = path.basename(row.projectMainRepoPath).toLowerCase();
		if (repoName !== normalizedRepo.repo) {
			return false;
		}

		if (!normalizedRepo.owner) {
			return true;
		}

		return (
			(row.projectGithubOwner ?? "").toLowerCase() === normalizedRepo.owner
		);
	});

	if (filteredCandidates.length === 0) {
		return null;
	}

	const match =
		(branchParam
			? filteredCandidates.find(
					(candidate) => candidate.workspaceBranch === branchParam,
				)
			: null) ?? filteredCandidates[0];

	if (!match) {
		return null;
	}

	const params = new URLSearchParams();
	if (fileParam?.trim()) {
		params.set("file", fileParam.trim());
	}

	const line = normalizeOptionalPositiveInt(url.searchParams.get("line"));
	if (line) {
		params.set("line", line);
	}

	const column = normalizeOptionalPositiveInt(url.searchParams.get("column"));
	if (column) {
		params.set("column", column);
	}

	const search = params.toString();
	return `/workspace/${match.workspaceId}${search ? `?${search}` : ""}`;
}

async function getRendererPathFromDeepLink(
	urlString: string,
): Promise<string | null> {
	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		return null;
	}

	if (parsed.hostname === "open") {
		return (
			(await resolveWorkspaceOpenRouteFromDeepLink(parsed)) ?? "/workspace"
		);
	}

	const host = parsed.hostname ? `/${parsed.hostname}` : "";
	const routePath = parsed.pathname === "/" ? "" : parsed.pathname;
	const search = parsed.search || "";
	const hash = parsed.hash || "";
	return `${host}${routePath}${search}${hash}` || "/";
}

async function processDeepLink(url: string): Promise<void> {
	console.log("[main] Processing deep link:", url);

	const authParams = parseAuthDeepLink(url);
	if (authParams) {
		const result = await handleAuthCallback(authParams);
		if (result.success) {
			focusMainWindow();
		} else {
			console.error("[main] Auth deep link failed:", result.error);
		}
		return;
	}

	const path = await getRendererPathFromDeepLink(url);
	if (!path) {
		console.error("[main] Failed to resolve deep link route:", url);
		return;
	}

	focusMainWindow();

	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		windows[0].webContents.send("deep-link-navigate", path);
	}
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
	return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
}

export function focusMainWindow(): void {
	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		const mainWindow = windows[0];
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
	} else {
		// Triggers window creation via makeAppSetup's activate handler
		app.emit("activate");
	}
}

function registerWithMacOSNotificationCenter() {
	if (!PLATFORM.IS_MAC || !Notification.isSupported()) return;

	const registrationNotification = new Notification({
		title: app.name,
		body: " ",
		silent: true,
	});

	let handled = false;
	const cleanup = () => {
		if (handled) return;
		handled = true;
		registrationNotification.close();
	};

	registrationNotification.on("show", () => {
		cleanup();
		console.log("[notifications] Registered with Notification Center");
	});

	// Fallback timeout in case macOS doesn't fire events
	setTimeout(cleanup, 1000);

	registrationNotification.show();
}

// macOS open-url can fire before the window exists (cold-start via protocol link).
// Queue the URL and process it after initialization.
let pendingDeepLinkUrl: string | null = null;
let appReady = false;

app.on("open-url", async (event, url) => {
	event.preventDefault();
	if (appReady) {
		await processDeepLink(url);
	} else {
		pendingDeepLinkUrl = url;
	}
});

export type QuitMode = "release" | "stop";
let pendingQuitMode: QuitMode | null = null;
let isQuitting = false;

/** Request the app to quit.
 *  - "release": keep services running (re-adoptable on next launch)
 *  - "stop": terminate all services before exit */
export function requestQuit(mode: QuitMode): void {
	pendingQuitMode = mode;
	app.quit();
}

/** Set quit mode without triggering quit.
 *  Use when another API (e.g. autoUpdater.quitAndInstall) triggers quit internally. */
export function prepareQuit(mode: QuitMode): void {
	pendingQuitMode = mode;
}

/** Exit the process immediately, bypassing before-quit.
 *  Services are left running for adoption on next launch. */
export function exitImmediately(): void {
	app.exit(0);
}

function getConfirmOnQuitSetting(): boolean {
	try {
		const row = localDb.select().from(settings).get();
		return row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
	} catch {
		return DEFAULT_CONFIRM_ON_QUIT;
	}
}

app.on("before-quit", async (event) => {
	if (isQuitting) return;

	// Consume the quit mode so it doesn't persist across aborted quits
	const quitMode = pendingQuitMode;
	pendingQuitMode = null;

	// FORK NOTE: macOS tray-stay-alive block removed to match upstream (#3205).
	// cleanupMainWindowResources() moved to the exit path below.
	const isDev = process.env.NODE_ENV === "development";
	if (quitMode === null && !isDev && getConfirmOnQuitSetting()) {
		event.preventDefault();

		try {
			const { response } = await dialog.showMessageBox({
				type: "question",
				buttons: ["Quit", "Cancel"],
				defaultId: 0,
				cancelId: 1,
				title: "Quit Superset",
				message: "Are you sure you want to quit?",
			});

			if (response === 1) {
				return;
			}
		} catch (error) {
			console.error("[main] Quit confirmation dialog failed:", error);
		}
	}

	isQuitting = true;
	// FORK NOTE: cleanup window resources before exit to prevent port conflicts
	cleanupMainWindowResources();
	// Fork-local: stop the todo-agent scheduler before closing local-db so an
	// in-flight tick can't insert a session into a closed SQLite handle.
	try {
		const { getTodoScheduler } = await import("./todo-agent/scheduler");
		getTodoScheduler().stop();
	} catch (error) {
		console.warn("[main] todo-agent scheduler stop skipped", error);
	}
	// Disconnect from the todo-agent daemon but leave it running so
	// `claude -p` child processes survive the app restart (issue #237).
	try {
		const { stopTodoAgentDaemonBridge } = await import(
			"./todo-agent/daemon-bridge"
		);
		stopTodoAgentDaemonBridge();
	} catch (error) {
		console.warn("[main] todo-agent daemon bridge stop skipped", error);
	}
	try {
		const mod = await loadVscodeShim();
		await mod.shutdownExtensionHost();
	} catch {}
	closeLocalDb();
	const manager = getHostServiceManager();
	if (quitMode === "stop") {
		manager.stopAll();
	} else {
		manager.releaseAll();
	}
	disposeTray();

	// app.exit() bypasses beforeunload in renderer processes, so tearoff windows
	// never return their tabs via the normal beforeunload path. Collect them here
	// and merge into persisted tabsState before the process exits.
	try {
		const { appState } = await import("./lib/app-state");
		const tearoffTabs = await windowManager.collectAllTearoffTabs(1500);
		if (tearoffTabs.length > 0) {
			const current = appState.data.tabsState;
			const existingIds = new Set(current.tabs.map((t) => t.id));
			const newEntries = tearoffTabs.filter(
				({ tab }) => !existingIds.has((tab as { id: string }).id),
			);
			if (newEntries.length > 0) {
				const newPanes: Record<string, unknown> = {};
				for (const { panes } of newEntries) {
					Object.assign(newPanes, panes);
				}
				appState.data.tabsState = {
					...current,
					tabs: [
						...current.tabs,
						...newEntries.map(({ tab }) => tab as (typeof current.tabs)[0]),
					],
					panes: { ...current.panes, ...newPanes } as typeof current.panes,
				};
				await appState.write();
			}
		}
	} catch (error) {
		console.error("[main] Failed to collect tearoff tabs before quit:", error);
	}

	app.exit(0);
});

process.on("uncaughtException", (error) => {
	if (isQuitting) return;
	console.error("[main] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
	if (isQuitting) return;
	console.error("[main] Unhandled rejection:", reason);
});

// Without these handlers, Electron may not quit when electron-vite sends SIGTERM
if (process.env.NODE_ENV === "development") {
	const handleTerminationSignal = (signal: string) => {
		console.log(`[main] Received ${signal}, quitting...`);
		app.exit(0);
	};

	process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
	process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

	// Fallback: electron-vite may exit without signaling the child Electron process
	const parentPid = process.ppid;
	const isParentAlive = (): boolean => {
		try {
			process.kill(parentPid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const parentCheckInterval = setInterval(() => {
		if (!isParentAlive()) {
			console.log("[main] Parent process exited, quitting...");
			clearInterval(parentCheckInterval);
			app.exit(0);
		}
	}, 1000);
	parentCheckInterval.unref();
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: "superset-icon",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-font",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-ext-icon",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-temp-audio",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "superset-workspace-media",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
			stream: true,
		},
	},
	{
		scheme: "vscode-webview-resource",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "vscode-webview",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
]);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.exit(0);
} else {
	// Windows/Linux: protocol URL arrives as argv on the second instance
	app.on("second-instance", async (_event, argv) => {
		focusMainWindow();
		const url = findDeepLinkInArgv(argv);
		if (url) {
			await processDeepLink(url);
		}
	});

	(async () => {
		await app.whenReady();
		registerWithMacOSNotificationCenter();
		requestAppleEventsAccess();
		initializeBrowserIdentityManager();
		initializeBrowserWebviewCompat();
		browserSitePermissionManager.initialize();
		// One-shot sweep of 30-day-old pasted attachments so userData
		// doesn't grow forever from screenshots dropped into TODOs.
		try {
			const { cleanupOldAttachments } = await import(
				"./todo-agent/attachments-cleanup"
			);
			cleanupOldAttachments();
		} catch (error) {
			console.warn("[main] todo-agent attachment cleanup skipped", error);
		}

		// Fork-local: prune terminal TODO sessions older than the
		// user-configured retention (0 = off). Runs after the attachment
		// sweep so deleted sessions' images also drop out of the
		// attachment reference set on the next run.
		try {
			const { cleanupOldSessions } = await import(
				"./todo-agent/sessions-cleanup"
			);
			cleanupOldSessions();
		} catch (error) {
			console.warn("[main] todo-agent session cleanup skipped", error);
		}

		// Fork-local: connect to the todo-agent daemon (spawning it if
		// necessary). The daemon owns `claude -p` child processes so
		// running TODO sessions survive app restarts — issue #237.
		try {
			const { startTodoAgentDaemonBridge } = await import(
				"./todo-agent/daemon-bridge"
			);
			await startTodoAgentDaemonBridge();
		} catch (error) {
			console.warn("[main] todo-agent daemon bridge failed", error);
		}

		// Fork-local: start the todo-agent schedule scheduler so cron-like
		// recurring TODOs fire while the app is running. Scheduler is a
		// noop until a user creates at least one schedule.
		try {
			const { getTodoScheduler } = await import("./todo-agent/scheduler");
			getTodoScheduler().start();
		} catch (error) {
			console.warn("[main] todo-agent scheduler start skipped", error);
			// Surface the failure via the existing schedule-fire event
			// bus so ScheduleFireToasts shows a one-off toast. Without
			// this the feature dies silently and the user keeps waiting
			// for fires that will never come.
			try {
				const { getTodoScheduleStore } = await import(
					"./todo-agent/schedule-store"
				);
				getTodoScheduleStore().emitFire({
					scheduleId: "__scheduler_init__",
					scheduleName: "スケジューラ",
					kind: "failed",
					sessionId: null,
					message:
						error instanceof Error
							? `起動に失敗しました: ${error.message}`
							: "起動に失敗しました",
					firedAt: Date.now(),
				});
			} catch {
				// If schedule-store itself failed to load there's
				// nothing we can surface — console.warn above is our
				// last resort.
			}
		}

		// Must register on both default session and the app's custom partition
		const iconProtocolHandler = (request: Request) => {
			const url = new URL(request.url);
			const projectId = url.pathname.replace(/^\//, "");
			const iconPath = getProjectIconPath(projectId);
			if (!iconPath) {
				return new Response("Not found", { status: 404 });
			}
			return net.fetch(pathToFileURL(iconPath).toString());
		};
		protocol.handle("superset-icon", iconProtocolHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-icon", iconProtocolHandler);

		// Serve system fonts (e.g. SF Mono on macOS) via custom protocol
		// so the renderer can use @font-face with font-src 'self' CSP
		if (process.platform === "darwin") {
			const SYSTEM_FONT_DIRS = [
				"/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts",
				"/System/Library/Fonts",
				"/Library/Fonts",
			];
			const fontProtocolHandler = async (request: Request) => {
				const url = new URL(request.url);
				const filename = path.basename(url.pathname);
				if (!/\.(otf|ttf|woff2?)$/i.test(filename)) {
					return new Response("Not found", { status: 404 });
				}
				for (const dir of SYSTEM_FONT_DIRS) {
					const fontPath = path.join(dir, filename);
					try {
						return await net.fetch(pathToFileURL(fontPath).toString());
					} catch {
						// Not in this directory
					}
				}
				return new Response("Not found", { status: 404 });
			};
			protocol.handle("superset-font", fontProtocolHandler);
			session
				.fromPartition("persist:superset")
				.protocol.handle("superset-font", fontProtocolHandler);
		}

		// Serve extension icons via custom protocol
		const extIconHandler = createExtensionIconProtocolHandler();
		protocol.handle("superset-ext-icon", extIconHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-ext-icon", extIconHandler);

		// Serve temp audio files (for YouTube import waveform editor)
		const tempAudioHandler = createTempAudioProtocolHandler();
		protocol.handle("superset-temp-audio", tempAudioHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-temp-audio", tempAudioHandler);

		// Serve workspace audio/video files for the file viewer
		const workspaceMediaHandler = createWorkspaceMediaProtocolHandler();
		protocol.handle("superset-workspace-media", workspaceMediaHandler);
		session
			.fromPartition("persist:superset")
			.protocol.handle("superset-workspace-media", workspaceMediaHandler);

		ensureProjectIconsDir();
		setWorkspaceDockIcon();
		initSentry();
		await initAppState();

		await loadWebviewBrowserExtension();
		await loadInstalledExtensions();

		// Must happen before renderer restore runs
		await reconcileDaemonSessions();
		prewarmTerminalRuntime();

		try {
			setupAgentHooks();
		} catch (error) {
			console.error("[main] Failed to set up agent hooks:", error);
		}

		// Discover and adopt host-services that survived a previous quit
		// before the tray initializes, so it shows accurate status immediately.
		await getHostServiceManager().discoverAll();

		if (IS_DEV) {
			getHostServiceManager().enableDevReload(async () => {
				const { token } = await loadToken();
				if (!token) return null;
				return { authToken: token, cloudApiUrl: mainEnv.NEXT_PUBLIC_API_URL };
			});
		}

		await makeAppSetup(() => MainWindow());
		setupAutoUpdater();
		setupServiceStatusPolling();
		initTray();

		// Initialize VS Code extension host (registers protocols, starts webview server)
		// Each workspace spawns its own worker process via ExtensionHostManager.
		loadVscodeShim()
			.then((mod) => mod.initExtensionHost())
			.catch((err) => {
				console.error(
					"[main] Failed to initialize VS Code extension host:",
					err,
				);
			});

		const coldStartUrl = findDeepLinkInArgv(process.argv);
		if (coldStartUrl) {
			await processDeepLink(coldStartUrl);
		}
		if (pendingDeepLinkUrl) {
			await processDeepLink(pendingDeepLinkUrl);
			pendingDeepLinkUrl = null;
		}

		appReady = true;
	})();
}
