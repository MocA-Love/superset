import type { ExternalApp } from "@superset/local-db";
import {
	createFileRoute,
	notFound,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { useFileOpenMode } from "renderer/hooks/useFileOpenMode";
import { useRightSidebarOpenViewWidth } from "renderer/hooks/useRightSidebarOpenViewWidth";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit";
import { useHotkey } from "renderer/hotkeys";
import {
	addBrowserShortcutListener,
	dispatchBrowserShortcutEvent,
} from "renderer/lib/browser-shortcut-events";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getWorkspaceDisplayName } from "renderer/lib/getWorkspaceDisplayName";
import { electronTrpcClient as trpcClient } from "renderer/lib/trpc-client";
import { usePresets } from "renderer/react-query/presets";
import type { WorkspaceSearchParams } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { usePresetHotkeys } from "renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/hooks/usePresetHotkeys";
import { useWorkspaceRunCommand } from "renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/hooks/useWorkspaceRunCommand";
import { NotFound } from "renderer/routes/not-found";
import {
	CommandPalette,
	useCommandPalette,
} from "renderer/screens/main/components/CommandPalette";
import { CreatePullRequestBaseRepoDialog } from "renderer/screens/main/components/CreatePullRequestBaseRepoDialog";
import { UnsavedChangesDialog } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/FileViewerPane/UnsavedChangesDialog";
import { useWorkspaceFileEventBridge } from "renderer/screens/main/components/WorkspaceView/hooks/useWorkspaceFileEvents";
import { useWorkspaceRenameReconciliation } from "renderer/screens/main/components/WorkspaceView/hooks/useWorkspaceRenameReconciliation";
import { WorkspaceIdProvider } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { WorkspaceInitializingView } from "renderer/screens/main/components/WorkspaceView/WorkspaceInitializingView";
import { WorkspaceLayout } from "renderer/screens/main/components/WorkspaceView/WorkspaceLayout";
import { useCreateOrOpenPR, usePRStatus } from "renderer/screens/main/hooks";
import { useDeepLinkNavigationStore } from "renderer/stores/deep-link-navigation";
import {
	cancelPendingTabClose,
	discardAndClosePendingTab,
	requestPaneClose,
	requestTabClose,
	saveAndClosePendingTab,
} from "renderer/stores/editor-state/editorCoordinator";
import { useEditorSessionsStore } from "renderer/stores/editor-state/useEditorSessionsStore";
import {
	RightSidebarTab,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { getPaneDimensions } from "renderer/stores/tabs/pane-refs";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import { useTabsWithPresets } from "renderer/stores/tabs/useTabsWithPresets";
import {
	extractPaneIdsFromLayout,
	type FocusDirection,
	findPanePath,
	getFirstPaneId,
	getSpatialNeighborMosaicPaneId,
	resolveActiveTabIdForWorkspace,
} from "renderer/stores/tabs/utils";
import {
	useHasWorkspaceFailed,
	useIsWorkspaceInitializing,
} from "renderer/stores/workspace-init";
import {
	normalizeComparablePath,
	toAbsoluteWorkspacePath,
} from "shared/absolute-paths";

const EMPTY_HISTORY_STACK: string[] = [];

export const Route = createFileRoute(
	"/_authenticated/_dashboard/workspace/$workspaceId/",
)({
	component: WorkspacePage,
	notFoundComponent: NotFound,
	validateSearch: (search: Record<string, unknown>): WorkspaceSearchParams => ({
		tabId: typeof search.tabId === "string" ? search.tabId : undefined,
		paneId: typeof search.paneId === "string" ? search.paneId : undefined,
		file: typeof search.file === "string" ? search.file : undefined,
		line: (() => {
			const v =
				typeof search.line === "number"
					? search.line
					: typeof search.line === "string" &&
							Number.isFinite(Number(search.line))
						? Number(search.line)
						: undefined;
			return v !== undefined && Number.isInteger(v) && v > 0 ? v : undefined;
		})(),
		column: (() => {
			const v =
				typeof search.column === "number"
					? search.column
					: typeof search.column === "string" &&
							Number.isFinite(Number(search.column))
						? Number(search.column)
						: undefined;
			return v !== undefined && Number.isInteger(v) && v > 0 ? v : undefined;
		})(),
	}),
	loader: async ({ params, context }) => {
		const queryKey = [
			["workspaces", "get"],
			{ input: { id: params.workspaceId }, type: "query" },
		];

		try {
			await context.queryClient.ensureQueryData({
				queryKey,
				queryFn: () =>
					trpcClient.workspaces.get.query({ id: params.workspaceId }),
			});
		} catch (error) {
			// If workspace not found, throw notFound() to render 404 page
			if (error instanceof Error && error.message.includes("not found")) {
				throw notFound();
			}
			// Re-throw other errors
			throw error;
		}
	},
});

export function WorkspacePage({
	workspaceIdOverride,
	isActive = true,
}: {
	workspaceIdOverride?: string;
	isActive?: boolean;
} = {}) {
	const routeParams = useParams({ strict: false }) as {
		workspaceId?: string;
	};
	const workspaceId = workspaceIdOverride ?? routeParams.workspaceId ?? "";
	const { data: workspace } = electronTrpc.workspaces.get.useQuery({
		id: workspaceId,
	});
	useWorkspaceFileEventBridge(
		workspaceId,
		workspace?.worktreePath,
		Boolean(workspace?.worktreePath),
	);
	useWorkspaceRenameReconciliation({
		workspaceId,
		worktreePath: workspace?.worktreePath,
		enabled: Boolean(workspace?.worktreePath),
	});
	const navigate = useNavigate();
	const searchParams = useSearch({
		strict: false,
	}) as Partial<WorkspaceSearchParams>;
	const searchTabId = searchParams?.tabId;
	const searchPaneId = searchParams?.paneId;
	const searchFile = searchParams?.file;
	const searchLine = searchParams?.line;
	const searchColumn = searchParams?.column;
	const hasRouteWorkspaceIntent =
		Boolean(searchTabId) ||
		Boolean(searchPaneId) ||
		Boolean(searchFile) ||
		searchLine !== undefined ||
		searchColumn !== undefined;
	const pendingWorkspaceIntent = useDeepLinkNavigationStore(
		(s) => s.pendingWorkspaceIntent,
	);
	const replacePendingWorkspaceIntent = useDeepLinkNavigationStore(
		(s) => s.replacePendingWorkspaceIntent,
	);
	const clearPendingWorkspaceIntent = useDeepLinkNavigationStore(
		(s) => s.clearPendingWorkspaceIntent,
	);
	const markPendingWorkspaceIntentTabHandled = useDeepLinkNavigationStore(
		(s) => s.markPendingWorkspaceIntentTabHandled,
	);
	const markPendingWorkspaceIntentFileHandled = useDeepLinkNavigationStore(
		(s) => s.markPendingWorkspaceIntentFileHandled,
	);

	// Keep the file open mode cache warm for addFileViewerPane
	useFileOpenMode();
	useRightSidebarOpenViewWidth();

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const hasTabsHydrated = useTabsStore((s) => s.hasHydrated ?? false);

	useEffect(() => {
		if (!isActive) return;
		if (!hasRouteWorkspaceIntent) return;

		replacePendingWorkspaceIntent({
			workspaceId,
			tabId: searchTabId,
			paneId: searchPaneId,
			file: searchFile,
			line: searchLine,
			column: searchColumn,
			source: "route-search",
		});

		navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId },
			search: {},
			replace: true,
		});
	}, [
		hasRouteWorkspaceIntent,
		isActive,
		navigate,
		replacePendingWorkspaceIntent,
		searchColumn,
		searchFile,
		searchLine,
		searchPaneId,
		searchTabId,
		workspaceId,
	]);

	useEffect(() => {
		if (!isActive) return;
		if (!pendingWorkspaceIntent) return;
		if (pendingWorkspaceIntent.workspaceId !== workspaceId) return;
		if (pendingWorkspaceIntent.expiresAt <= Date.now()) {
			clearPendingWorkspaceIntent(pendingWorkspaceIntent.id);
			return;
		}
		if (pendingWorkspaceIntent.tabHandled) return;
		if (!pendingWorkspaceIntent.tabId) return;
		if (!hasTabsHydrated) return;

		const { tabId, paneId } = pendingWorkspaceIntent;
		const state = useTabsStore.getState();
		const tab = state.tabs.find(
			(t) => t.id === tabId && t.workspaceId === workspaceId,
		);
		if (!tab) {
			markPendingWorkspaceIntentTabHandled(pendingWorkspaceIntent.id);
			return;
		}

		state.setActiveTab(workspaceId, tabId);

		if (paneId && state.panes[paneId]) {
			state.setFocusedPane(tabId, paneId);
		}

		markPendingWorkspaceIntentTabHandled(pendingWorkspaceIntent.id);
	}, [
		hasTabsHydrated,
		clearPendingWorkspaceIntent,
		isActive,
		markPendingWorkspaceIntentTabHandled,
		pendingWorkspaceIntent,
		workspaceId,
	]);

	useEffect(() => {
		if (!isActive) return;
		if (!pendingWorkspaceIntent) return;
		if (pendingWorkspaceIntent.workspaceId !== workspaceId) return;
		if (pendingWorkspaceIntent.expiresAt <= Date.now()) {
			clearPendingWorkspaceIntent(pendingWorkspaceIntent.id);
			return;
		}
		if (pendingWorkspaceIntent.fileHandled) return;
		if (!pendingWorkspaceIntent.file || !workspace?.worktreePath) return;
		if (pendingWorkspaceIntent.tabId && !pendingWorkspaceIntent.tabHandled) {
			return;
		}

		const filePath = toAbsoluteWorkspacePath(
			workspace.worktreePath,
			pendingWorkspaceIntent.file,
		);

		const normalizedRoot = normalizeComparablePath(workspace.worktreePath);
		const normalizedFile = normalizeComparablePath(filePath);
		if (
			normalizedFile !== normalizedRoot &&
			!normalizedFile.startsWith(`${normalizedRoot}/`)
		) {
			markPendingWorkspaceIntentFileHandled(pendingWorkspaceIntent.id);
			return;
		}

		addFileViewerPane(workspaceId, {
			filePath,
			line: pendingWorkspaceIntent.line,
			column: pendingWorkspaceIntent.column,
			viewMode: "raw",
			isPinned: true,
			useRightSidebarOpenViewWidth: true,
		});

		markPendingWorkspaceIntentFileHandled(pendingWorkspaceIntent.id);
	}, [
		addFileViewerPane,
		clearPendingWorkspaceIntent,
		isActive,
		markPendingWorkspaceIntentFileHandled,
		pendingWorkspaceIntent,
		workspace?.worktreePath,
		workspaceId,
	]);

	useEffect(() => {
		if (!isActive) return;
		if (!pendingWorkspaceIntent) return;
		if (pendingWorkspaceIntent.workspaceId !== workspaceId) return;
		if (!pendingWorkspaceIntent.tabHandled) return;
		if (!pendingWorkspaceIntent.fileHandled) return;

		clearPendingWorkspaceIntent(pendingWorkspaceIntent.id);
	}, [
		clearPendingWorkspaceIntent,
		isActive,
		pendingWorkspaceIntent,
		workspaceId,
	]);

	// Check if workspace is initializing or failed
	const isInitializing = useIsWorkspaceInitializing(workspaceId);
	const hasFailed = useHasWorkspaceFailed(workspaceId);

	// Check for incomplete init after app restart
	const gitStatus = workspace?.worktree?.gitStatus;
	const hasIncompleteInit =
		workspace?.type === "worktree" &&
		(gitStatus === null || gitStatus === undefined);

	// Show full-screen initialization view for:
	// - Actively initializing workspaces (shows progress)
	// - Failed workspaces (shows error with retry)
	// - Interrupted workspaces that aren't currently initializing (shows resume option)
	const showInitView = isInitializing || hasFailed || hasIncompleteInit;

	const allTabs = useTabsStore((s) => s.tabs);
	const activeTabIdForWorkspace = useTabsStore(
		(s) => s.activeTabIds[workspaceId] ?? null,
	);
	const tabHistoryStack = useTabsStore(
		(s) => s.tabHistoryStacks[workspaceId] ?? EMPTY_HISTORY_STACK,
	);
	const {
		addTab,
		splitPaneAuto,
		splitPaneVertical,
		splitPaneHorizontal,
		openPreset,
	} = useTabsWithPresets(workspace?.projectId);
	const addChatTab = useTabsStore((s) => s.addChatTab);
	const reopenClosedTab = useTabsStore((s) => s.reopenClosedTab);
	const addBrowserTab = useTabsStore((s) => s.addBrowserTab);
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const setSidebarOpen = useSidebarStore((s) => s.setSidebarOpen);
	const currentSidebarMode = useSidebarStore((s) => s.currentMode);
	const setSidebarMode = useSidebarStore((s) => s.setMode);
	const setRightSidebarTab = useSidebarStore((s) => s.setRightSidebarTab);

	const tabs = useMemo(
		() => allTabs.filter((tab) => tab.workspaceId === workspaceId),
		[workspaceId, allTabs],
	);

	const activeTabId = useMemo(() => {
		return resolveActiveTabIdForWorkspace({
			workspaceId,
			tabs,
			activeTabIds: { [workspaceId]: activeTabIdForWorkspace },
			tabHistoryStacks: { [workspaceId]: tabHistoryStack },
		});
	}, [workspaceId, tabs, activeTabIdForWorkspace, tabHistoryStack]);

	const activeTab = useMemo(
		() => (activeTabId ? tabs.find((t) => t.id === activeTabId) : null),
		[activeTabId, tabs],
	);

	const focusedPaneId = useTabsStore((s) =>
		activeTabId ? (s.focusedPaneIds[activeTabId] ?? null) : null,
	);
	const pendingTabClose = useEditorSessionsStore((s) =>
		s.pendingTabClose?.workspaceId === workspaceId ? s.pendingTabClose : null,
	);

	const { toggleWorkspaceRun } = useWorkspaceRunCommand({
		workspaceId,
		worktreePath: workspace?.worktreePath,
	});

	const { matchedPresets: presets } = usePresets(workspace?.projectId);

	const openTabWithPreset = useCallback(
		(presetIndex: number) => {
			const preset = presets[presetIndex];
			if (preset) {
				openPreset(workspaceId, preset, { target: "active-tab" });
			} else {
				addTab(workspaceId);
			}
		},
		[presets, workspaceId, addTab, openPreset],
	);

	useHotkey("NEW_GROUP", () => addTab(workspaceId), { enabled: isActive });
	useHotkey("NEW_CHAT", () => addChatTab(workspaceId), { enabled: isActive });
	useHotkey(
		"REOPEN_TAB",
		() => {
			if (!reopenClosedTab(workspaceId)) {
				addChatTab(workspaceId);
			}
		},
		{ enabled: isActive },
	);
	useHotkey("NEW_BROWSER", () => addBrowserTab(workspaceId), {
		enabled: isActive,
	});
	usePresetHotkeys(openTabWithPreset, { enabled: isActive });

	useHotkey("RUN_WORKSPACE_COMMAND", () => toggleWorkspaceRun(), {
		enabled: isActive,
	});

	useHotkey(
		"CLOSE_TERMINAL",
		() => {
			if (focusedPaneId) {
				requestPaneClose(focusedPaneId);
			}
		},
		{ enabled: isActive },
	);
	useHotkey(
		"CLOSE_TAB",
		() => {
			if (activeTabId) {
				requestTabClose(activeTabId);
			}
		},
		{ enabled: isActive },
	);

	useHotkey(
		"PREV_TAB",
		() => {
			if (!activeTabId || tabs.length === 0) return;
			const index = tabs.findIndex((t) => t.id === activeTabId);
			const prevIndex = index <= 0 ? tabs.length - 1 : index - 1;
			setActiveTab(workspaceId, tabs[prevIndex].id);
		},
		{ enabled: isActive },
	);

	useHotkey(
		"NEXT_TAB",
		() => {
			if (!activeTabId || tabs.length === 0) return;
			const index = tabs.findIndex((t) => t.id === activeTabId);
			const nextIndex =
				index >= tabs.length - 1 || index === -1 ? 0 : index + 1;
			setActiveTab(workspaceId, tabs[nextIndex].id);
		},
		{ enabled: isActive },
	);

	useHotkey(
		"PREV_TAB_ALT",
		() => {
			if (!activeTabId || tabs.length === 0) return;
			const index = tabs.findIndex((t) => t.id === activeTabId);
			const prevIndex = index <= 0 ? tabs.length - 1 : index - 1;
			setActiveTab(workspaceId, tabs[prevIndex].id);
		},
		{ enabled: isActive },
	);

	useHotkey(
		"NEXT_TAB_ALT",
		() => {
			if (!activeTabId || tabs.length === 0) return;
			const index = tabs.findIndex((t) => t.id === activeTabId);
			const nextIndex =
				index >= tabs.length - 1 || index === -1 ? 0 : index + 1;
			setActiveTab(workspaceId, tabs[nextIndex].id);
		},
		{ enabled: isActive },
	);

	const switchToTab = useCallback(
		(index: number) => {
			const tab = tabs[index];
			if (tab) {
				setActiveTab(workspaceId, tab.id);
			}
		},
		[tabs, workspaceId, setActiveTab],
	);

	useHotkey("JUMP_TO_TAB_1", () => switchToTab(0), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_2", () => switchToTab(1), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_3", () => switchToTab(2), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_4", () => switchToTab(3), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_5", () => switchToTab(4), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_6", () => switchToTab(5), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_7", () => switchToTab(6), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_8", () => switchToTab(7), { enabled: isActive });
	useHotkey("JUMP_TO_TAB_9", () => switchToTab(8), { enabled: isActive });

	// Open in last used app shortcut
	const projectId = workspace?.projectId;
	const { data: defaultApp } = electronTrpc.projects.getDefaultApp.useQuery(
		{ projectId: projectId as string },
		{ enabled: !!projectId },
	);
	const resolvedDefaultApp: ExternalApp = defaultApp ?? "cursor";
	const utils = electronTrpc.useUtils();
	const { mutate: mutateOpenInApp } =
		electronTrpc.external.openInApp.useMutation({
			onSuccess: () => {
				if (projectId) {
					utils.projects.getDefaultApp.invalidate({ projectId });
				}
			},
		});
	const handleOpenInApp = useCallback(() => {
		if (workspace?.worktreePath) {
			mutateOpenInApp({
				path: workspace.worktreePath,
				app: resolvedDefaultApp,
				projectId,
			});
		}
	}, [workspace?.worktreePath, resolvedDefaultApp, mutateOpenInApp, projectId]);
	// FORK NOTE: upstream #3511 removed this page-level hotkey to avoid double
	// firing with OpenInMenuButton. Fork tearoff windows do not render TopBar
	// (layout.tsx gates it on !isTearoff), so OpenInMenuButton is absent there
	// — keep the page-level registration alive only in tearoff windows.
	useHotkey("OPEN_IN_APP", handleOpenInApp, {
		enabled: isActive && isTearoffWindow(),
	});

	// Copy path shortcut
	const { copyToClipboard } = useCopyToClipboard();
	useHotkey(
		"COPY_PATH",
		() => {
			if (workspace?.worktreePath) {
				copyToClipboard(workspace.worktreePath);
			}
		},
		{ enabled: isActive },
	);

	// Open PR shortcut (⌘⇧P)
	const { pr } = usePRStatus({ workspaceId, surface: "workspace-page" });
	const {
		createOrOpenPR,
		baseRepoDialog,
		isPending: isCreateOrOpenPRPending,
	} = useCreateOrOpenPR({
		worktreePath: workspace?.worktreePath,
	});
	useHotkey(
		"OPEN_PR",
		() => {
			if (pr?.url) {
				window.open(pr.url, "_blank");
			} else {
				createOrOpenPR();
			}
		},
		{ enabled: isActive },
	);

	const commandPalette = useCommandPalette({
		workspaceId,
		navigate,
		enabled: isActive,
	});
	const handleQuickOpen = useCallback(() => {
		commandPalette.toggle();
	}, [commandPalette.toggle]);
	useHotkey("QUICK_OPEN", handleQuickOpen, { enabled: isActive });

	const handleBrowserShortcut = useCallback(
		(action: "reload" | "hard-reload") => {
			if (!isActive) return;

			const state = useTabsStore.getState();
			const workspaceTabs = state.tabs.filter(
				(tab) => tab.workspaceId === workspaceId,
			);
			const resolvedActiveTabId = resolveActiveTabIdForWorkspace({
				workspaceId,
				tabs: workspaceTabs,
				activeTabIds: state.activeTabIds,
				tabHistoryStacks: state.tabHistoryStacks,
			});

			if (!resolvedActiveTabId) return;

			const activeWorkspaceTab = workspaceTabs.find(
				(tab) => tab.id === resolvedActiveTabId,
			);
			if (!activeWorkspaceTab) return;

			const focusedWorkspacePaneId = state.focusedPaneIds[resolvedActiveTabId];
			const focusedPane = focusedWorkspacePaneId
				? state.panes[focusedWorkspacePaneId]
				: null;

			if (
				focusedPane?.tabId === resolvedActiveTabId &&
				focusedPane.type === "webview" &&
				focusedPane.browser
			) {
				void trpcClient.browser.reload.mutate({
					paneId: focusedPane.id,
					hard: action === "hard-reload",
				});
				return;
			}

			const browserPanes = extractPaneIdsFromLayout(activeWorkspaceTab.layout)
				.map((paneId) => state.panes[paneId])
				.filter(
					(pane): pane is NonNullable<typeof pane> =>
						Boolean(pane) && pane.type === "webview" && Boolean(pane.browser),
				);

			if (browserPanes.length !== 1) return;

			void trpcClient.browser.reload.mutate({
				paneId: browserPanes[0].id,
				hard: action === "hard-reload",
			});
		},
		[isActive, workspaceId],
	);

	// FORK NOTE: useHotkey wiring so remapped keys also trigger browser reload
	useHotkey("BROWSER_RELOAD", () => dispatchBrowserShortcutEvent("reload"), {
		enabled: isActive,
	});
	useHotkey(
		"BROWSER_HARD_RELOAD",
		() => dispatchBrowserShortcutEvent("hard-reload"),
		{ enabled: isActive },
	);

	useEffect(() => {
		return addBrowserShortcutListener(handleBrowserShortcut);
	}, [handleBrowserShortcut]);

	const handleSearchInFiles = useCallback(() => {
		if (!isSidebarOpen) {
			setSidebarOpen(true);
		}
		setSidebarMode(SidebarMode.Tabs);
		if (workspaceId) {
			setRightSidebarTab(workspaceId, RightSidebarTab.Search);
		}
	}, [
		isSidebarOpen,
		workspaceId,
		setRightSidebarTab,
		setSidebarMode,
		setSidebarOpen,
	]);
	useHotkey("SEARCH_IN_FILES", handleSearchInFiles, { enabled: isActive });

	// Toggle changes sidebar (⌘L)
	useHotkey("TOGGLE_SIDEBAR", () => toggleSidebar(), { enabled: isActive });

	// Toggle expand/collapse sidebar (⌘⇧L)
	useHotkey(
		"TOGGLE_EXPAND_SIDEBAR",
		() => {
			if (!isSidebarOpen) {
				setSidebarOpen(true);
				setSidebarMode(SidebarMode.Changes);
			} else {
				const isExpanded = currentSidebarMode === SidebarMode.Changes;
				setSidebarMode(isExpanded ? SidebarMode.Tabs : SidebarMode.Changes);
			}
		},
		{ enabled: isActive },
	);

	// Pane splitting helper - resolves target pane for split operations
	const resolveSplitTarget = useCallback(
		(paneId: string, tabId: string, targetTab: Tab) => {
			const path = findPanePath(targetTab.layout, paneId);
			if (path !== null) return { path, paneId };

			const firstPaneId = getFirstPaneId(targetTab.layout);
			const firstPanePath = findPanePath(targetTab.layout, firstPaneId);
			setFocusedPane(tabId, firstPaneId);
			return { path: firstPanePath ?? [], paneId: firstPaneId };
		},
		[setFocusedPane],
	);

	// Pane splitting shortcuts
	useHotkey(
		"SPLIT_AUTO",
		() => {
			if (activeTabId && focusedPaneId && activeTab) {
				const target = resolveSplitTarget(
					focusedPaneId,
					activeTabId,
					activeTab,
				);
				if (!target) return;
				const dimensions = getPaneDimensions(target.paneId);
				if (dimensions) {
					splitPaneAuto(activeTabId, target.paneId, dimensions, target.path);
				}
			}
		},
		{ enabled: isActive },
	);

	useHotkey(
		"SPLIT_RIGHT",
		() => {
			if (activeTabId && focusedPaneId && activeTab) {
				const target = resolveSplitTarget(
					focusedPaneId,
					activeTabId,
					activeTab,
				);
				if (!target) return;
				splitPaneVertical(activeTabId, target.paneId, target.path);
			}
		},
		{ enabled: isActive },
	);

	useHotkey(
		"SPLIT_DOWN",
		() => {
			if (activeTabId && focusedPaneId && activeTab) {
				const target = resolveSplitTarget(
					focusedPaneId,
					activeTabId,
					activeTab,
				);
				if (!target) return;
				splitPaneHorizontal(activeTabId, target.paneId, target.path);
			}
		},
		{ enabled: isActive },
	);

	useHotkey(
		"SPLIT_WITH_CHAT",
		() => {
			if (activeTabId && focusedPaneId && activeTab) {
				const target = resolveSplitTarget(
					focusedPaneId,
					activeTabId,
					activeTab,
				);
				if (!target) return;
				splitPaneVertical(activeTabId, target.paneId, target.path, {
					paneType: "chat",
				});
			}
		},
		{ enabled: isActive },
	);

	useHotkey(
		"SPLIT_WITH_BROWSER",
		() => {
			if (activeTabId && focusedPaneId && activeTab) {
				const target = resolveSplitTarget(
					focusedPaneId,
					activeTabId,
					activeTab,
				);
				if (!target) return;
				splitPaneVertical(activeTabId, target.paneId, target.path, {
					paneType: "webview",
				});
			}
		},
		{ enabled: isActive },
	);

	const equalizePaneSplits = useTabsStore((s) => s.equalizePaneSplits);
	useHotkey(
		"EQUALIZE_PANE_SPLITS",
		() => {
			if (activeTabId) {
				equalizePaneSplits(activeTabId);
			}
		},
		{ enabled: isActive },
	);

	// FORK NOTE: upstream #3460 introduces v1 directional pane focus via
	// FOCUS_PANE_{LEFT,RIGHT,UP,DOWN}. The default bindings are unbound after
	// #3472 (Cmd+Alt+Arrow goes back to prev/next tab/workspace), so this only
	// fires when the user explicitly rebinds the FOCUS_PANE_* ids in Settings.
	// `enabled: isActive` is required so inactive WorkspacePage instances
	// kept mounted by KeepAliveWorkspaces don't also register the hotkey.
	const moveFocusDirectional = useCallback(
		(dir: FocusDirection) => {
			if (!activeTabId || !activeTab?.layout || !focusedPaneId) return;
			const neighbor = getSpatialNeighborMosaicPaneId(
				activeTab.layout,
				focusedPaneId,
				dir,
			);
			if (neighbor) setFocusedPane(activeTabId, neighbor);
		},
		[activeTabId, activeTab?.layout, focusedPaneId, setFocusedPane],
	);
	useHotkey("FOCUS_PANE_LEFT", () => moveFocusDirectional("left"), {
		enabled: isActive,
	});
	useHotkey("FOCUS_PANE_RIGHT", () => moveFocusDirectional("right"), {
		enabled: isActive,
	});
	useHotkey("FOCUS_PANE_UP", () => moveFocusDirectional("up"), {
		enabled: isActive,
	});
	useHotkey("FOCUS_PANE_DOWN", () => moveFocusDirectional("down"), {
		enabled: isActive,
	});

	// FORK NOTE: v1 workspace uses tRPC-based prev/next workspace navigation.
	// Upstream removed these handlers in #3403 (they use DashboardSidebar's
	// flattenedWorkspaces instead). Fork keeps tRPC approach for v1.
	const getPreviousWorkspace =
		electronTrpc.workspaces.getPreviousWorkspace.useQuery(
			{ id: workspaceId },
			{ enabled: !!workspaceId },
		);
	useHotkey(
		"PREV_WORKSPACE",
		() => {
			const prevWorkspaceId = getPreviousWorkspace.data;
			if (prevWorkspaceId) {
				navigateToWorkspace(prevWorkspaceId, navigate);
			}
		},
		{ enabled: isActive },
	);

	const getNextWorkspace = electronTrpc.workspaces.getNextWorkspace.useQuery(
		{ id: workspaceId },
		{ enabled: !!workspaceId },
	);
	useHotkey(
		"NEXT_WORKSPACE",
		() => {
			const nextWorkspaceId = getNextWorkspace.data;
			if (nextWorkspaceId) {
				navigateToWorkspace(nextWorkspaceId, navigate);
			}
		},
		{ enabled: isActive },
	);

	return (
		<WorkspaceIdProvider value={workspaceId}>
			<div className="flex-1 h-full flex flex-col overflow-hidden">
				<div className="flex-1 min-h-0 flex overflow-hidden">
					{showInitView ? (
						<WorkspaceInitializingView
							workspaceId={workspaceId}
							workspaceName={workspace?.name ?? "Workspace"}
							isInterrupted={hasIncompleteInit && !isInitializing}
						/>
					) : (
						<WorkspaceLayout
							workspaceId={workspaceId}
							isActive={isActive}
							defaultExternalApp={resolvedDefaultApp}
							onOpenInApp={handleOpenInApp}
							onOpenQuickOpen={handleQuickOpen}
						/>
					)}
				</div>
				<CommandPalette
					open={isActive ? commandPalette.open : false}
					onOpenChange={commandPalette.handleOpenChange}
					query={commandPalette.query}
					onQueryChange={commandPalette.setQuery}
					filtersOpen={commandPalette.filtersOpen}
					onFiltersOpenChange={commandPalette.setFiltersOpen}
					includePattern={commandPalette.includePattern}
					onIncludePatternChange={commandPalette.setIncludePattern}
					excludePattern={commandPalette.excludePattern}
					onExcludePatternChange={commandPalette.setExcludePattern}
					isLoading={commandPalette.isFetching}
					searchResults={commandPalette.searchResults}
					onSelectFile={commandPalette.selectFile}
					scope={commandPalette.scope}
					onScopeChange={commandPalette.setScope}
					workspaceName={
						workspace
							? getWorkspaceDisplayName(
									workspace.name,
									workspace.type,
									workspace.project?.name,
								)
							: undefined
					}
					includeIgnored={commandPalette.includeIgnored}
					onToggleIncludeIgnored={commandPalette.toggleIncludeIgnored}
				/>
				<UnsavedChangesDialog
					open={pendingTabClose !== null}
					onOpenChange={(open) => {
						if (!open) {
							cancelPendingTabClose(workspaceId);
						}
					}}
					onSave={() => {
						void saveAndClosePendingTab(workspaceId).catch((error) => {
							console.error(
								"[WorkspacePage] Failed to save dirty files before closing tab",
								{
									workspaceId,
									error,
								},
							);
						});
					}}
					onDiscard={() => discardAndClosePendingTab(workspaceId)}
					isSaving={pendingTabClose?.isSaving ?? false}
					description={
						pendingTabClose
							? pendingTabClose.documentKeys.length === 1
								? "This tab has unsaved changes in 1 file. What would you like to do before closing it?"
								: `This tab has unsaved changes in ${pendingTabClose.documentKeys.length} files. What would you like to do before closing it?`
							: undefined
					}
					discardLabel="Discard & Close Tab"
					saveLabel="Save & Close Tab"
				/>
				<CreatePullRequestBaseRepoDialog
					open={baseRepoDialog.open}
					options={baseRepoDialog.options}
					isPending={isCreateOrOpenPRPending}
					onOpenChange={baseRepoDialog.onOpenChange}
					onConfirm={baseRepoDialog.onConfirm}
				/>
			</div>
		</WorkspaceIdProvider>
	);
}
