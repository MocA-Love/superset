import type { BrowserWindow } from "electron";
import type { WindowManager } from "main/lib/window-manager";
// Fork-local: TODO autonomous agent feature.
import { createTodoAgentRouter } from "main/todo-agent";
import { router } from "..";
import { createAnalyticsRouter } from "./analytics";
import { createAuthRouter } from "./auth";
import { createAutoUpdateRouter } from "./auto-update";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserHistoryRouter } from "./browser-history";
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
import { createModelProvidersRouter } from "./model-providers";
import { createNotificationsRouter } from "./notifications";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectsRouter } from "./projects";
import { createReferenceGraphRouter } from "./reference-graph";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createRingtoneRouter } from "./ringtone";
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
		analytics: createAnalyticsRouter(),
		browser: createBrowserRouter(),
		browserHistory: createBrowserHistoryRouter(),
		auth: createAuthRouter(),
		autoUpdate: createAutoUpdateRouter(),
		cache: createCacheRouter(),
		modelProviders: createModelProvidersRouter(),
		window: createWindowRouter(getWindow),
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
		hostServiceCoordinator: createHostServiceCoordinatorRouter(),
		tabTearoff: createTabTearoffRouter(wm),
		extensions: createExtensionsRouter(getWindow),
		vibrancy: createVibrancyRouter(wm),
		vscodeExtensions: createVscodeExtensionsRouter(),
		todoAgent: createTodoAgentRouter(),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;
