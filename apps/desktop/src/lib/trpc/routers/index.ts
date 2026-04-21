import type { BrowserWindow } from "electron";
import type { WindowManager } from "main/lib/window-manager";
// Fork-local: TODO autonomous agent feature.
import { createTodoAgentRouter } from "main/todo-agent/trpc-router";
import { router } from "..";
import { createAgentCommandExecutionRouter } from "./agent-command-execution";
import { createAivisRouter } from "./aivis";
import { createAnalyticsRouter } from "./analytics";
import { createAuthRouter } from "./auth";
import { createAutoUpdateRouter } from "./auto-update";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserAutomationRouter } from "./browser-automation";
import { createBrowserHistoryRouter } from "./browser-history";
import { createBrowserPermissionsRouter } from "./browser-permissions";
import { createBrowserViewRouter } from "./browser-view";
import { createCacheRouter } from "./cache";
import { createChangesRouter } from "./changes";
import { createChatRuntimeServiceRouter } from "./chat-runtime-service";
import { createChatServiceRouter } from "./chat-service";
import { createConfigRouter } from "./config";
import { createDatabasesRouter } from "./databases";
import { createDiagnosticsRouter } from "./diagnostics";
import { createDockerRouter } from "./docker";
import { createExtensionsRouter } from "./extensions";
import { createExternalRouter } from "./external";
import { createFilesystemRouter } from "./filesystem";
import { createGitHubMetricsRouter } from "./github-metrics";
import { createHostServiceCoordinatorRouter } from "./host-service-coordinator";
import { createLanguageServicesRouter } from "./language-services";
import { createMenuRouter } from "./menu";
import { createNotificationsRouter } from "./notifications";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectsRouter } from "./projects";
import { createReferenceGraphRouter } from "./reference-graph";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createRingtoneRouter } from "./ringtone";
import { createServiceStatusRouter } from "./service-status";
import { createSettingsRouter } from "./settings";
import { createTabTearoffRouter } from "./tab-tearoff";
import { createTerminalRouter } from "./terminal";
import { createUiStateRouter } from "./ui-state";
import { createVibrancyRouter } from "./vibrancy";
import { createVscodeExtensionsRouter } from "./vscode-extensions";
import { createWindowRouter } from "./window";
import { createWorkspacesRouter } from "./workspaces";

export const createAppRouter = (
	getWindow: () => BrowserWindow | null,
	wm: WindowManager,
) => {
	return router({
		chatRuntimeService: createChatRuntimeServiceRouter(),
		chatService: createChatServiceRouter(),
		agentCommandExecution: createAgentCommandExecutionRouter(),
		aivis: createAivisRouter(),
		analytics: createAnalyticsRouter(),
		browser: createBrowserRouter(),
		browserAutomation: createBrowserAutomationRouter(),
		browserHistory: createBrowserHistoryRouter(),
		browserPermissions: createBrowserPermissionsRouter(),
		browserView: createBrowserViewRouter(),
		auth: createAuthRouter(),
		autoUpdate: createAutoUpdateRouter(),
		cache: createCacheRouter(),
		window: createWindowRouter(getWindow, wm),
		projects: createProjectsRouter(getWindow),
		workspaces: createWorkspacesRouter(),
		terminal: createTerminalRouter(),
		changes: createChangesRouter(),
		filesystem: createFilesystemRouter(),
		githubMetrics: createGitHubMetricsRouter(),
		notifications: createNotificationsRouter(),
		permissions: createPermissionsRouter(),
		ports: createPortsRouter(),
		resourceMetrics: createResourceMetricsRouter(),
		menu: createMenuRouter(),
		languageServices: createLanguageServicesRouter(),
		referenceGraph: createReferenceGraphRouter(),
		external: createExternalRouter(),
		settings: createSettingsRouter(),
		config: createConfigRouter(),
		databases: createDatabasesRouter(),
		diagnostics: createDiagnosticsRouter(),
		docker: createDockerRouter(),
		uiState: createUiStateRouter(),
		ringtone: createRingtoneRouter(getWindow),
		serviceStatus: createServiceStatusRouter(),
		hostServiceCoordinator: createHostServiceCoordinatorRouter(),
		tabTearoff: createTabTearoffRouter(wm),
		extensions: createExtensionsRouter(getWindow),
		vibrancy: createVibrancyRouter(wm),
		vscodeExtensions: createVscodeExtensionsRouter(),
		todoAgent: createTodoAgentRouter(),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;
