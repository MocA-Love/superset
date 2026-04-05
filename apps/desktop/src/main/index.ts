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
	parseAuthDeepLink,
} from "lib/trpc/routers/auth/utils/auth-functions";
import { fetchGitHubOwner } from "lib/trpc/routers/projects/utils/github";
import { applyShellEnvToProcess } from "lib/trpc/routers/workspaces/utils/shell-env";
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
import { resolveDevWorkspaceName } from "./lib/dev-workspace-name";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { createExtensionIconProtocolHandler } from "./lib/extensions/extension-icon-protocol";
import { loadInstalledExtensions } from "./lib/extensions/extension-manager";
import { getHostServiceManager } from "./lib/host-service-manager";
import { closeLocalDb, localDb } from "./lib/local-db";
import { ensureProjectIconsDir, getProjectIconPath } from "./lib/project-icons";
import { initSentry } from "./lib/sentry";
import {
	prewarmTerminalRuntime,
	reconcileDaemonSessions,
} from "./lib/terminal";
import { disposeTray, initTray } from "./lib/tray";
import { MainWindow } from "./windows/main";

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

	const manager = getHostServiceManager();

	// macOS: close windows & keep tray alive when services should stay running
	if (
		PLATFORM.IS_MAC &&
		(quitMode === null || quitMode === "release") &&
		manager.hasActiveInstances()
	) {
		event.preventDefault();
		for (const win of BrowserWindow.getAllWindows()) {
			win.destroy();
		}
		return;
	}

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
	closeLocalDb();
	if (quitMode === "stop") {
		manager.stopAll();
	} else {
		manager.releaseAll();
	}
	disposeTray();
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
		browserSitePermissionManager.initialize();

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
		await getHostServiceManager().discoverAndAdoptAll();

		await makeAppSetup(() => MainWindow());
		setupAutoUpdater();
		initTray();

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
