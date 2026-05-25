import { type LayoutNode, type SplitPath, Workspace } from "@superset/panes";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@superset/ui/resizable";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuickOpenStore } from "renderer/commandPalette/ui/QuickOpen/quickOpenStore";
import { useRightSidebarOpenViewWidth } from "renderer/hooks/useRightSidebarOpenViewWidth";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useHotkey } from "renderer/hotkeys";
import {
	addBrowserShortcutListener,
	dispatchBrowserShortcutEvent,
} from "renderer/lib/browser-shortcut-events";
import { createWorkspaceMemo } from "renderer/lib/workspace-memos";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	CommandPalette,
	useCommandPalette,
} from "renderer/screens/main/components/CommandPalette";
import { getV2NotificationSourcesForTab } from "renderer/stores/v2-notifications";
import {
	toAbsoluteWorkspacePath,
	toRelativeWorkspacePath,
} from "shared/absolute-paths";
import { useStore } from "zustand";
import { useWorkspace } from "../providers/WorkspaceProvider";
import { AddTabMenu } from "./components/AddTabMenu";
import { BackgroundTerminalsButton } from "./components/BackgroundTerminalsButton";
import { V2NotificationStatusIndicator } from "./components/V2NotificationStatusIndicator";
import { V2PresetsBar } from "./components/V2PresetsBar";
import { V2WorkspaceRunButton } from "./components/V2WorkspaceRunButton";
import { WorkspaceEmptyState } from "./components/WorkspaceEmptyState";
import { WorkspaceMissingWorktreeState } from "./components/WorkspaceMissingWorktreeState";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useBrowserShellInteractionPassthrough } from "./hooks/useBrowserShellInteractionPassthrough";
import { useClearActivePaneAttention } from "./hooks/useClearActivePaneAttention";
import { useConsumeAutomationRunLink } from "./hooks/useConsumeAutomationRunLink";
import { useConsumeOpenUrlRequest } from "./hooks/useConsumeOpenUrlRequest";
import { useDefaultContextMenuActions } from "./hooks/useDefaultContextMenuActions";
import { useDefaultPaneActions } from "./hooks/useDefaultPaneActions";
import { useDirtyTabCloseGuard } from "./hooks/useDirtyTabCloseGuard";
import { usePaneRegistry } from "./hooks/usePaneRegistry";
import { renderBrowserTabIcon } from "./hooks/usePaneRegistry/components/BrowserPane";
import { useRecentlyViewedFiles } from "./hooks/useRecentlyViewedFiles";
import { useV2PresetExecution } from "./hooks/useV2PresetExecution";
import { useV2TerminalLauncher } from "./hooks/useV2TerminalLauncher";
import { useV2WorkspacePaneLayout } from "./hooks/useV2WorkspacePaneLayout";
import { useV2WorkspaceRun } from "./hooks/useV2WorkspaceRun";
import { useWorkspaceHotkeys } from "./hooks/useWorkspaceHotkeys";
import { useWorkspacePaneOpeners } from "./hooks/useWorkspacePaneOpeners";
import { WorkspaceGitStatusProvider } from "./providers/WorkspaceGitStatusProvider";
import { FileDocumentStoreProvider } from "./state/fileDocumentStore";
import type { BrowserPaneData, FilePaneData, PaneViewerData } from "./types";
import type { V2WorkspaceUrlOpenTarget } from "./utils/openUrlInV2Workspace";

interface WorkspaceSearch {
	terminalId?: string;
	chatSessionId?: string;
	focusRequestId?: string;
	openUrl?: string;
	openUrlTarget?: V2WorkspaceUrlOpenTarget;
	openUrlRequestId?: string;
}

function parseOpenUrlTarget(
	value: unknown,
): V2WorkspaceUrlOpenTarget | undefined {
	if (value === "current-tab" || value === "new-tab") return value;
	return undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const Route = createFileRoute(
	"/_authenticated/_dashboard/v2-workspace/$workspaceId/",
)({
	component: V2WorkspacePage,
	validateSearch: (raw: Record<string, unknown>): WorkspaceSearch => ({
		terminalId: parseNonEmptyString(raw.terminalId),
		chatSessionId: parseNonEmptyString(raw.chatSessionId),
		focusRequestId: parseNonEmptyString(raw.focusRequestId),
		openUrl: parseNonEmptyString(raw.openUrl),
		openUrlTarget: parseOpenUrlTarget(raw.openUrlTarget),
		openUrlRequestId: parseNonEmptyString(raw.openUrlRequestId),
	}),
});

function findPanePathInLayout(
	node: LayoutNode,
	paneId: string,
	currentPath: SplitPath = [],
): SplitPath | null {
	if (node.type === "pane") {
		return node.paneId === paneId ? currentPath : null;
	}

	const firstPath = findPanePathInLayout(node.first, paneId, [
		...currentPath,
		"first",
	]);
	if (firstPath) return firstPath;

	const secondPath = findPanePathInLayout(node.second, paneId, [
		...currentPath,
		"second",
	]);
	if (secondPath) return secondPath;

	return null;
}

function getNodeAtPathInLayout(
	node: LayoutNode,
	path: SplitPath,
): LayoutNode | null {
	if (path.length === 0) return node;
	if (node.type === "pane") return null;

	const [branch, ...rest] = path;
	return getNodeAtPathInLayout(node[branch], rest);
}

function V2WorkspacePage() {
	const { workspace } = useWorkspace();
	const {
		terminalId,
		chatSessionId,
		focusRequestId,
		openUrl,
		openUrlTarget,
		openUrlRequestId,
	} = Route.useSearch();
	const workspaceStatusQuery = workspaceTrpc.workspace.get.useQuery(
		{ id: workspace.id },
		{
			refetchOnWindowFocus: true,
			retry: false,
		},
	);

	if (workspaceStatusQuery.data?.worktreeExists === false) {
		return (
			<WorkspaceMissingWorktreeState
				workspaceId={workspace.id}
				workspaceName={workspace.name}
				branch={workspace.branch}
				worktreePath={workspaceStatusQuery.data.worktreePath}
				onRefresh={() => {
					void workspaceStatusQuery.refetch();
				}}
				isRefreshing={workspaceStatusQuery.isFetching}
			/>
		);
	}

	return (
		// key={workspaceId} so each workspace gets its own pane store rather
		// than sharing one and replaceState-ing data across switches.
		<WorkspaceContent
			key={workspace.id}
			projectId={workspace.projectId}
			workspaceId={workspace.id}
			terminalId={terminalId}
			chatSessionId={chatSessionId}
			focusRequestId={focusRequestId}
			openUrl={openUrl}
			openUrlTarget={openUrlTarget}
			openUrlRequestId={openUrlRequestId}
		/>
	);
}

function WorkspaceContent({
	projectId,
	workspaceId,
	terminalId,
	chatSessionId,
	focusRequestId,
	openUrl,
	openUrlTarget,
	openUrlRequestId,
}: {
	projectId: string;
	workspaceId: string;
	terminalId?: string;
	chatSessionId?: string;
	focusRequestId?: string;
	openUrl?: string;
	openUrlTarget?: V2WorkspaceUrlOpenTarget;
	openUrlRequestId?: string;
}) {
	const navigate = useNavigate();
	const { localWorkspaceState, store } = useV2WorkspacePaneLayout();
	const { preferences: v2UserPreferences, setShowPresetsBar } =
		useV2UserPreferences();
	const showPresetsBar = v2UserPreferences.showPresetsBar;
	useClearActivePaneAttention({ store });
	const launcher = useV2TerminalLauncher();
	const { matchedPresets, executePreset, resolvePresetCommands } =
		useV2PresetExecution({
			store,
			projectId,
			launcher,
		});
	const workspaceRun = useV2WorkspaceRun({
		store,
		launcher,
		matchedPresets,
		resolvePresetCommands,
	});
	useConsumeAutomationRunLink({
		store,
		workspaceId,
		terminalId,
		chatSessionId,
		focusRequestId,
	});
	const collections = useCollections();
	const rightSidebarOpenViewWidth = useRightSidebarOpenViewWidth();
	useConsumeOpenUrlRequest({
		store,
		url: openUrl,
		target: openUrlTarget,
		requestId: openUrlRequestId,
	});

	const workspaceQuery = workspaceTrpc.workspace.get.useQuery({
		id: workspaceId,
	});
	const worktreePath = workspaceQuery.data?.worktreePath ?? "";

	const { recentFiles, recordView } = useRecentlyViewedFiles(workspaceId);

	const recordRecentlyViewed = useCallback(
		(filePath: string) => {
			if (!worktreePath) return;
			const absolutePath = toAbsoluteWorkspacePath(worktreePath, filePath);
			const relativePath = toRelativeWorkspacePath(worktreePath, filePath);
			if (!relativePath || relativePath === ".") return;
			recordView({ relativePath, absolutePath });
		},
		[recordView, worktreePath],
	);

	const activeFilePanePath = useStore(store, (s) => {
		const tab = s.tabs.find((t) => t.id === s.activeTabId);
		if (!tab?.activePaneId) return undefined;
		const pane = tab.panes[tab.activePaneId];
		if (pane?.kind === "file") return (pane.data as FilePaneData).filePath;
		return undefined;
	});

	const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(
		activeFilePanePath,
	);
	// Every reveal request is a fresh object, so the FilesTab effect keyed on
	// `pendingReveal` re-runs even when the path is the same (e.g. user
	// collapsed a folder and re-⌘-clicked it in the terminal).
	const [pendingReveal, setPendingReveal] = useState<{
		path: string;
		isDirectory: boolean;
	} | null>(null);

	useEffect(() => {
		if (activeFilePanePath !== undefined) {
			setSelectedFilePath(activeFilePanePath);
			setPendingReveal({ path: activeFilePanePath, isDirectory: false });
		}
	}, [activeFilePanePath]);

	const openFilePathsKey = useStore(store, (s) =>
		s.tabs
			.flatMap((t) =>
				Object.values(t.panes)
					.filter((p) => p.kind === "file")
					.map((p) => (p.data as FilePaneData).filePath),
			)
			.join("\u0000"),
	);
	const openFilePaths = useMemo(
		() => new Set(openFilePathsKey ? openFilePathsKey.split("\u0000") : []),
		[openFilePathsKey],
	);

	// FORK NOTE: quick-open / command-palette path that optionally carries a
	// memo-derived displayName for the tab title. Upstream unified this with
	// sidebar open into a single `openFilePane(filePath, openInNewTab)`; the
	// fork keeps two variants so memo tabs can forward the derived title.
	const openFilePane = useCallback(
		(
			filePath: string,
			displayName?: string,
			location?: { line?: number; column?: number },
		) => {
			recordRecentlyViewed(filePath);
			const state = store.getState();
			const cursorRequestId =
				location?.line !== undefined ? crypto.randomUUID() : undefined;
			for (const tab of state.tabs) {
				for (const pane of Object.values(tab.panes)) {
					if (
						pane.kind !== "file" ||
						(pane.data as FilePaneData).filePath !== filePath
					) {
						continue;
					}
					const paneData = pane.data as FilePaneData;
					const shouldUpdateData =
						(displayName && paneData.displayName !== displayName) ||
						location?.line !== undefined ||
						location?.column !== undefined;
					state.setActiveTab(tab.id);
					state.setActivePane({ tabId: tab.id, paneId: pane.id });
					if (!shouldUpdateData) return;
					state.setPaneData({
						paneId: pane.id,
						data: {
							...paneData,
							displayName: displayName ?? paneData.displayName,
							line: location?.line,
							column: location?.column,
							cursorRequestId,
						} as FilePaneData,
					});
					return;
				}
			}
			state.openPane({
				pane: {
					kind: "file",
					data: {
						filePath,
						mode: "editor",
						displayName,
						line: location?.line,
						column: location?.column,
						cursorRequestId,
					} as FilePaneData,
				},
			});
		},
		[recordRecentlyViewed, store],
	);

	// FORK NOTE: opening from the file tree / sidebar adjusts the active
	// horizontal split so the newly opened file takes
	// `rightSidebarOpenViewWidth`. Upstream does not have this width
	// auto-correction because it does not expose a user-configurable
	// right-sidebar-open width.
	const openSidebarFilePane = useCallback(
		(filePath: string, openInNewTab?: boolean) => {
			// Defensively resolve to absolute path: git diff yields relative paths,
			// but FilePane requires an absolute path for ensureWithinRoot checks.
			const absoluteFilePath =
				worktreePath && !filePath.startsWith("/")
					? toAbsoluteWorkspacePath(worktreePath, filePath)
					: filePath;
			recordRecentlyViewed(absoluteFilePath);
			const state = store.getState();
			if (openInNewTab) {
				state.addTab({
					panes: [
						{
							kind: "file",
							data: {
								filePath: absoluteFilePath,
								mode: "editor",
							} as FilePaneData,
						},
					],
				});
				return;
			}
			const active = state.getActivePane();
			const activeTab = active
				? (state.tabs.find((tab) => tab.id === active.tabId) ?? null)
				: null;
			if (
				active?.pane.kind === "file" &&
				(active.pane.data as FilePaneData).filePath === absoluteFilePath
			) {
				state.setPanePinned({ paneId: active.pane.id, pinned: true });
				return;
			}
			for (const tab of state.tabs) {
				for (const pane of Object.values(tab.panes)) {
					if (
						pane.kind === "file" &&
						(pane.data as FilePaneData).filePath === absoluteFilePath
					) {
						state.setActiveTab(tab.id);
						state.setActivePane({ tabId: tab.id, paneId: pane.id });
						return;
					}
				}
			}

			const activeTabId = state.activeTabId;
			const activePaneId = active?.pane.id ?? null;
			const activePanePath =
				activeTab?.layout && activePaneId
					? findPanePathInLayout(activeTab.layout, activePaneId)
					: null;

			state.openPane({
				pane: {
					kind: "file",
					data: {
						filePath: absoluteFilePath,
						mode: "editor",
					} as FilePaneData,
				},
			});

			if (!activeTabId || !activePanePath) {
				return;
			}

			const nextState = store.getState();
			const nextTab = nextState.tabs.find((tab) => tab.id === activeTabId);
			if (!nextTab) {
				return;
			}

			const splitNode = getNodeAtPathInLayout(nextTab.layout, activePanePath);
			if (splitNode?.type !== "split" || splitNode.direction !== "horizontal") {
				return;
			}

			nextState.resizeSplit({
				tabId: activeTabId,
				path: activePanePath,
				splitPercentage: 100 - rightSidebarOpenViewWidth,
			});
		},
		[rightSidebarOpenViewWidth, store, recordRecentlyViewed, worktreePath],
	);

	const revealPath = useCallback(
		(path: string, options?: { isDirectory?: boolean }) => {
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.rightSidebarOpen = true;
				draft.sidebarState.activeTab = "files";
			});
			setSelectedFilePath(path);
			setPendingReveal({ path, isDirectory: options?.isDirectory === true });
		},
		[collections, workspaceId],
	);

	// FORK NOTE: fork's openFilePane takes (filePath, displayName?) for the
	// memo-title path. Pane registry callers that pass an explicit
	// `openInNewTab` use the sidebar-opening path so they can honor the
	// file-open preference and right-sidebar split width, while callers that
	// omit the 2nd arg keep the legacy "open in the active pane" behavior.
	const handleTerminalOpenFile = useCallback(
		(filePath: string, openInNewTab?: boolean) => {
			if (openInNewTab !== undefined) {
				openSidebarFilePane(filePath, openInNewTab);
				return;
			}

			openFilePane(filePath);
		},
		[openFilePane, openSidebarFilePane],
	);

	const paneRegistry = usePaneRegistry({
		onOpenFile: handleTerminalOpenFile,
		onRevealPath: revealPath,
		launcher,
	});
	const defaultContextMenuActions = useDefaultContextMenuActions({
		paneRegistry,
		launcher,
	});
	const {
		openDiffPane,
		addTerminalTab,
		addChatTab,
		addBrowserTab,
		openCommentPane,
	} = useWorkspacePaneOpeners({ store, launcher });

	const defaultPaneActions = useDefaultPaneActions({ launcher });
	const onBeforeCloseTab = useDirtyTabCloseGuard();

	// FORK NOTE: Fork-only "New Memo" action from the add-tab menu. Creates
	// an empty markdown memo in ~/.superset/memos and opens it in the file
	// pane with its derived title.
	const addMemoTab = useCallback(() => {
		void createWorkspaceMemo(workspaceId)
			.then((memo) => {
				openFilePane(memo.memoFileAbsolutePath, memo.displayName);
			})
			.catch((error: Error) => {
				toast.error(`Failed to create memo: ${error.message}`);
			});
	}, [openFilePane, workspaceId]);

	const openFilePathsList = useMemo(
		() => Array.from(openFilePaths),
		[openFilePaths],
	);
	const recentFilePathsList = useMemo(
		() => recentFiles.map((file) => file.absolutePath),
		[recentFiles],
	);

	// FORK NOTE: fork uses the richer `useCommandPalette` (supports filters,
	// cross-workspace open, scope switching) instead of upstream's simple
	// boolean-state palette.
	const commandPalette = useCommandPalette({
		workspaceId,
		navigate,
		openFilePaths: openFilePathsList,
		recentFilePaths: recentFilePathsList,
		onSelectFile: ({ close, filePath, targetWorkspaceId, line, column }) => {
			close();
			if (targetWorkspaceId !== workspaceId) {
				void navigate({
					to: "/v2-workspace/$workspaceId",
					params: { workspaceId: targetWorkspaceId },
				});
				return;
			}
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.rightSidebarOpen = true;
				draft.sidebarState.activeTab = "files";
			});
			openFilePane(filePath, undefined, { line, column });
		},
	});
	const quickOpenOpen = useQuickOpenStore(
		(s) => s.open && s.target?.workspaceId === workspaceId,
	);
	const closeQuickOpen = useQuickOpenStore((s) => s.close);
	const openQuickOpenFor = useQuickOpenStore((s) => s.openFor);

	useEffect(() => {
		if (quickOpenOpen && !commandPalette.open) {
			commandPalette.handleOpenChange(true);
		}
	}, [quickOpenOpen, commandPalette.open, commandPalette.handleOpenChange]);

	useEffect(() => {
		if (!commandPalette.open && quickOpenOpen) {
			closeQuickOpen();
		}
	}, [commandPalette.open, quickOpenOpen, closeQuickOpen]);

	const handleQuickOpen = useCallback(() => {
		if (commandPalette.open) {
			commandPalette.handleOpenChange(false);
			closeQuickOpen();
			return;
		}
		openQuickOpenFor({ workspaceId });
	}, [commandPalette, closeQuickOpen, openQuickOpenFor, workspaceId]);

	// FORK NOTE: fork は sidebar 状態を v2UserPreferences ではなく
	// localWorkspaceState から読む (cycle 09 の portal slot まわりの設計と整合)。
	// upstream #3744 の useBrowserShellInteractionPassthrough は fork の sidebarOpen
	// (= localWorkspaceState 由来) をそのまま渡せば動く。
	const sidebarOpen = localWorkspaceState?.rightSidebarOpen ?? false;
	const { onSidebarResizeDragging, onWorkspaceInteractionStateChange } =
		useBrowserShellInteractionPassthrough({ sidebarOpen });

	useWorkspaceHotkeys({
		store,
		workspaceId,
		matchedPresets,
		executePreset,
		paneRegistry,
		launcher,
	});
	useHotkey("QUICK_OPEN", handleQuickOpen);
	useHotkey("RUN_WORKSPACE_COMMAND", () => {
		void workspaceRun.toggleWorkspaceRun();
	});
	// FORK NOTE: SEARCH_IN_FILES opens CommandPalette in v2 (equivalent to classic's right sidebar search tab)
	useHotkey("SEARCH_IN_FILES", handleQuickOpen);
	// FORK NOTE: useHotkey wiring so remapped keys also trigger browser reload
	useHotkey("BROWSER_RELOAD", () => dispatchBrowserShortcutEvent("reload"));
	useHotkey("BROWSER_HARD_RELOAD", () =>
		dispatchBrowserShortcutEvent("hard-reload"),
	);

	// FORK NOTE: BROWSER_RELOAD / BROWSER_HARD_RELOAD support for v2 workspace.
	// Hard reload appends a cache-bust query param; normal reload just swaps the key.
	useEffect(() => {
		return addBrowserShortcutListener((action) => {
			const activePane = store.getState().getActivePane();
			if (!activePane || activePane.pane.kind !== "browser") {
				return;
			}

			const data = activePane.pane.data as BrowserPaneData;
			const isHard = action === "hard-reload";
			store.getState().setPaneData({
				paneId: activePane.pane.id,
				data: {
					...data,
					reloadToken: crypto.randomUUID(),
					...(isHard && { hardReloadToken: crypto.randomUUID() }),
				} as PaneViewerData,
			});
		});
	}, [store]);

	const workspaceRunButton = (
		<V2WorkspaceRunButton
			projectId={projectId}
			definition={workspaceRun.definition}
			isRunning={workspaceRun.isRunning}
			isPending={workspaceRun.isPending}
			canForceStop={workspaceRun.canForceStop}
			onToggle={workspaceRun.toggleWorkspaceRun}
			onForceStop={workspaceRun.forceStopWorkspaceRun}
		/>
	);

	return (
		<FileDocumentStoreProvider>
			<WorkspaceGitStatusProvider
				workspaceId={workspaceId}
				store={store}
				sidebarOpen={sidebarOpen}
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="min-h-0 min-w-0 flex-1 overflow-auto"
				>
					<ResizablePanel
						className="min-w-[320px]"
						defaultSize={80}
						minSize={30}
					>
						<div
							className="flex min-h-0 min-w-0 h-full flex-col overflow-hidden"
							data-workspace-id={workspaceId}
						>
							<Workspace<PaneViewerData>
								key={workspaceId}
								registry={paneRegistry}
								paneActions={defaultPaneActions}
								contextMenuActions={defaultContextMenuActions}
								renderTabIcon={renderBrowserTabIcon}
								renderTabAccessory={(tab) => (
									<V2NotificationStatusIndicator
										sources={getV2NotificationSourcesForTab(tab)}
									/>
								)}
								renderTabBarTrailing={() => (
									<BackgroundTerminalsButton
										workspaceId={workspaceId}
										store={store}
									/>
								)}
								renderBelowTabBar={() =>
									showPresetsBar ? (
										<V2PresetsBar
											matchedPresets={matchedPresets}
											executePreset={executePreset}
											showPresetsBar={showPresetsBar}
											onToggleShowPresetsBar={setShowPresetsBar}
											trailing={workspaceRunButton}
										/>
									) : (
										<div className="flex h-8 min-w-0 shrink-0 items-center border-b border-border bg-background px-2">
											{workspaceRunButton}
										</div>
									)
								}
								renderAddTabMenu={() => (
									<AddTabMenu
										onAddTerminal={addTerminalTab}
										onAddChat={addChatTab}
										onAddBrowser={addBrowserTab}
										onAddMemo={addMemoTab}
										showPresetsBar={showPresetsBar}
										onToggleShowPresetsBar={setShowPresetsBar}
									/>
								)}
								renderEmptyState={() => (
									<WorkspaceEmptyState
										onOpenBrowser={addBrowserTab}
										onOpenChat={addChatTab}
										onOpenMemo={addMemoTab}
										onOpenQuickOpen={handleQuickOpen}
										onOpenTerminal={addTerminalTab}
									/>
								)}
								onBeforeCloseTab={onBeforeCloseTab}
								onInteractionStateChange={onWorkspaceInteractionStateChange}
								store={store}
							/>
						</div>
					</ResizablePanel>
					{sidebarOpen && (
						<>
							<ResizableHandle onDragging={onSidebarResizeDragging} />
							<ResizablePanel
								className="min-w-[220px]"
								defaultSize={20}
								minSize={15}
								maxSize={40}
							>
								<WorkspaceSidebar
									workspaceId={workspaceId}
									onSelectFile={openSidebarFilePane}
									onSelectDiffFile={openDiffPane}
									onOpenComment={openCommentPane}
									onSearch={handleQuickOpen}
									selectedFilePath={selectedFilePath}
									pendingReveal={pendingReveal}
								/>
							</ResizablePanel>
						</>
					)}
				</ResizablePanelGroup>
			</WorkspaceGitStatusProvider>
			<CommandPalette
				excludePattern={commandPalette.excludePattern}
				filtersOpen={commandPalette.filtersOpen}
				includePattern={commandPalette.includePattern}
				isLoading={commandPalette.isFetching}
				onExcludePatternChange={commandPalette.setExcludePattern}
				onFiltersOpenChange={commandPalette.setFiltersOpen}
				onIncludePatternChange={commandPalette.setIncludePattern}
				onOpenChange={commandPalette.handleOpenChange}
				onQueryChange={commandPalette.setQuery}
				onScopeChange={commandPalette.setScope}
				onSelectFile={commandPalette.selectFile}
				open={commandPalette.open}
				openFilePaths={openFilePaths}
				query={commandPalette.query}
				recentlyViewedFiles={recentFiles}
				scope={commandPalette.scope}
				searchResults={commandPalette.searchResults}
				includeIgnored={commandPalette.includeIgnored}
				onToggleIncludeIgnored={commandPalette.toggleIncludeIgnored}
			/>
		</FileDocumentStoreProvider>
	);
}
