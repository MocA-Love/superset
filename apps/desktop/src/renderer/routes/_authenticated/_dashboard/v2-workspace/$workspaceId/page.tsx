import {
	type LayoutNode,
	type PaneActionConfig,
	type SplitPath,
	Workspace,
	type WorkspaceStore,
} from "@superset/panes";
import { alert } from "@superset/ui/atoms/Alert";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@superset/ui/resizable";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { TbLayoutColumns, TbLayoutRows } from "react-icons/tb";
import { useRightSidebarOpenViewWidth } from "renderer/hooks/useRightSidebarOpenViewWidth";
import { HotkeyLabel, useHotkey } from "renderer/hotkeys";
import {
	addBrowserShortcutListener,
	dispatchBrowserShortcutEvent,
} from "renderer/lib/browser-shortcut-events";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getBaseName } from "renderer/lib/pathBasename";
import { createWorkspaceMemo } from "renderer/lib/workspace-memos";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	CommandPalette,
	useCommandPalette,
} from "renderer/screens/main/components/CommandPalette";
import {
	getV2NotificationSourcesForPane,
	getV2NotificationSourcesForTab,
	useV2NotificationStore,
	useV2PaneNotificationStatus,
} from "renderer/stores/v2-notifications";
import {
	toAbsoluteWorkspacePath,
	toRelativeWorkspacePath,
} from "shared/absolute-paths";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { WorkspaceNotFoundState } from "../components/WorkspaceNotFoundState";
import { AddTabMenu } from "./components/AddTabMenu";
import { V2NotificationStatusIndicator } from "./components/V2NotificationStatusIndicator";
import { V2PresetsBar } from "./components/V2PresetsBar";
import { WorkspaceEmptyState } from "./components/WorkspaceEmptyState";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useBrowserShellInteractionPassthrough } from "./hooks/useBrowserShellInteractionPassthrough";
import { useConsumeAutomationRunLink } from "./hooks/useConsumeAutomationRunLink";
import { useConsumeOpenUrlRequest } from "./hooks/useConsumeOpenUrlRequest";
import { useConsumePendingLaunch } from "./hooks/useConsumePendingLaunch";
import { useDefaultContextMenuActions } from "./hooks/useDefaultContextMenuActions";
import { usePaneRegistry } from "./hooks/usePaneRegistry";
import { renderBrowserTabIcon } from "./hooks/usePaneRegistry/components/BrowserPane";
import { useRecentlyViewedFiles } from "./hooks/useRecentlyViewedFiles";
import { useV2PresetExecution } from "./hooks/useV2PresetExecution";
import { useV2WorkspacePaneLayout } from "./hooks/useV2WorkspacePaneLayout";
import { useWorkspaceHotkeys } from "./hooks/useWorkspaceHotkeys";
import {
	FileDocumentStoreProvider,
	getDocument,
} from "./state/fileDocumentStore";
import type {
	BrowserPaneData,
	ChatPaneData,
	CommentPaneData,
	DiffPaneData,
	FilePaneData,
	PaneViewerData,
	TerminalPaneData,
} from "./types";
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
	const { workspaceId } = Route.useParams();
	const {
		terminalId,
		chatSessionId,
		focusRequestId,
		openUrl,
		openUrlTarget,
		openUrlRequestId,
	} = Route.useSearch();
	const collections = useCollections();

	const { data: workspaces } = useLiveQuery(
		(q) =>
			q
				.from({ v2Workspaces: collections.v2Workspaces })
				.where(({ v2Workspaces }) => eq(v2Workspaces.id, workspaceId)),
		[collections, workspaceId],
	);
	const workspace = workspaces?.[0] ?? null;

	if (!workspaces) {
		return <div className="flex h-full w-full" />;
	}

	if (!workspace) {
		return <WorkspaceNotFoundState workspaceId={workspaceId} />;
	}

	return (
		<WorkspaceContent
			projectId={workspace.projectId}
			workspaceId={workspace.id}
			workspaceName={workspace.name}
			terminalId={terminalId}
			chatSessionId={chatSessionId}
			focusRequestId={focusRequestId}
			openUrl={openUrl}
			openUrlTarget={openUrlTarget}
			openUrlRequestId={openUrlRequestId}
		/>
	);
}

/**
 * Clear post-completion attention only for the pane the user is actually
 * viewing. Clearing every review status on route entry would drop background
 * tab attention before the user has looked at that pane.
 */
function useClearActivePaneAttention({
	workspaceId,
	store,
}: {
	workspaceId: string;
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
}): void {
	const activePane = useStore(store, (state) => {
		const tab = state.tabs.find(
			(candidate) => candidate.id === state.activeTabId,
		);
		return tab?.activePaneId ? tab.panes[tab.activePaneId] : undefined;
	});
	const activePaneStatus = useV2PaneNotificationStatus(workspaceId, activePane);
	const clearSourceAttention = useV2NotificationStore(
		(state) => state.clearSourceAttention,
	);

	useEffect(() => {
		if (activePaneStatus !== "review") return;
		for (const source of getV2NotificationSourcesForPane(activePane)) {
			clearSourceAttention(source, workspaceId);
		}
	}, [activePane, activePaneStatus, clearSourceAttention, workspaceId]);
}

function WorkspaceContent({
	projectId,
	workspaceId,
	workspaceName,
	terminalId,
	chatSessionId,
	focusRequestId,
	openUrl,
	openUrlTarget,
	openUrlRequestId,
}: {
	projectId: string;
	workspaceId: string;
	workspaceName: string;
	terminalId?: string;
	chatSessionId?: string;
	focusRequestId?: string;
	openUrl?: string;
	openUrlTarget?: V2WorkspaceUrlOpenTarget;
	openUrlRequestId?: string;
}) {
	const navigate = useNavigate();
	const { localWorkspaceState, store } = useV2WorkspacePaneLayout({
		projectId,
		workspaceId,
	});
	useClearActivePaneAttention({ workspaceId, store });
	const { matchedPresets, executePreset } = useV2PresetExecution({
		store,
		workspaceId,
		projectId,
	});
	useConsumePendingLaunch({ workspaceId, store });
	useConsumeAutomationRunLink({
		store,
		terminalId,
		chatSessionId,
		focusRequestId,
	});
	const collections = useCollections();
	const rightSidebarOpenViewWidth = useRightSidebarOpenViewWidth();
	const utils = electronTrpc.useUtils();
	const { data: showPresetsBar } =
		electronTrpc.settings.getShowPresetsBar.useQuery();
	const setShowPresetsBar = electronTrpc.settings.setShowPresetsBar.useMutation(
		{
			onMutate: async ({ enabled }) => {
				await utils.settings.getShowPresetsBar.cancel();
				const previous = utils.settings.getShowPresetsBar.getData();
				utils.settings.getShowPresetsBar.setData(undefined, enabled);
				return { previous };
			},
			onError: (_error, _variables, context) => {
				utils.settings.getShowPresetsBar.setData(undefined, context?.previous);
			},
			onSettled: () => {
				utils.settings.getShowPresetsBar.invalidate();
			},
		},
	);
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
			const active = state.getActivePane();
			if (
				active?.pane.kind === "file" &&
				(active.pane.data as FilePaneData).filePath === filePath
			) {
				const activeData = active.pane.data as FilePaneData;
				const shouldUpdateData =
					(displayName && activeData.displayName !== displayName) ||
					location?.line !== undefined ||
					location?.column !== undefined;
				if (shouldUpdateData) {
					state.setPaneData({
						paneId: active.pane.id,
						data: {
							...activeData,
							displayName: displayName ?? activeData.displayName,
							line: location?.line,
							column: location?.column,
							cursorRequestId,
						} as FilePaneData,
					});
				}
				state.setPanePinned({ paneId: active.pane.id, pinned: true });
				return;
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

	const paneRegistry = usePaneRegistry(workspaceId, {
		onOpenFile: handleTerminalOpenFile,
		onRevealPath: revealPath,
	});
	const defaultContextMenuActions = useDefaultContextMenuActions(paneRegistry);

	const openDiffPane = useCallback(
		(filePath: string, openInNewTab?: boolean) => {
			const state = store.getState();
			if (openInNewTab) {
				state.addTab({
					panes: [
						{
							kind: "diff",
							data: {
								path: filePath,
								collapsedFiles: [],
							} as DiffPaneData,
						},
					],
				});
				return;
			}
			for (const tab of state.tabs) {
				for (const pane of Object.values(tab.panes)) {
					if (pane.kind !== "diff") continue;
					const prev = pane.data as DiffPaneData;
					state.setPaneData({
						paneId: pane.id,
						data: {
							...prev,
							path: filePath,
						} as PaneViewerData,
					});
					state.setActiveTab(tab.id);
					state.setActivePane({ tabId: tab.id, paneId: pane.id });
					return;
				}
			}
			state.openPane({
				pane: {
					kind: "diff",
					data: {
						path: filePath,
						collapsedFiles: [],
					} as DiffPaneData,
				},
			});
		},
		[store],
	);

	const addTerminalTab = useCallback(() => {
		store.getState().addTab({
			panes: [
				{
					kind: "terminal",
					data: {
						terminalId: crypto.randomUUID(),
					} as TerminalPaneData,
				},
			],
		});
	}, [store]);

	const addChatTab = useCallback(() => {
		store.getState().addTab({
			panes: [
				{
					kind: "chat",
					data: { sessionId: null } as ChatPaneData,
				},
			],
		});
	}, [store]);

	const addBrowserTab = useCallback(() => {
		store.getState().addTab({
			panes: [
				{
					kind: "browser",
					data: {
						url: "about:blank",
					} as BrowserPaneData,
				},
			],
		});
	}, [store]);

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

	const openCommentPane = useCallback(
		(comment: CommentPaneData) => {
			const state = store.getState();
			for (const tab of state.tabs) {
				for (const pane of Object.values(tab.panes)) {
					if (pane.kind !== "comment") continue;
					state.setPaneData({
						paneId: pane.id,
						data: comment as PaneViewerData,
					});
					state.setActiveTab(tab.id);
					state.setActivePane({ tabId: tab.id, paneId: pane.id });
					return;
				}
			}
			state.addTab({
				panes: [
					{
						kind: "comment",
						data: comment as PaneViewerData,
					},
				],
			});
		},
		[store],
	);

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
			openFilePane(filePath, undefined, { line, column });
		},
	});

	const handleQuickOpen = useCallback(() => {
		commandPalette.toggle();
	}, [commandPalette]);

	const defaultPaneActions = useMemo<PaneActionConfig<PaneViewerData>[]>(
		() => [
			{
				key: "split",
				icon: (ctx) =>
					ctx.pane.parentDirection === "horizontal" ? (
						<TbLayoutRows className="size-3.5" />
					) : (
						<TbLayoutColumns className="size-3.5" />
					),
				tooltip: <HotkeyLabel label="Split pane" id="SPLIT_AUTO" />,
				onClick: (ctx) => {
					const position =
						ctx.pane.parentDirection === "horizontal" ? "down" : "right";
					ctx.actions.split(position, {
						kind: "terminal",
						data: {
							terminalId: crypto.randomUUID(),
						} as TerminalPaneData,
					});
				},
			},
			{
				key: "close",
				icon: <HiMiniXMark className="size-3.5" />,
				tooltip: <HotkeyLabel label="Close pane" id="CLOSE_PANE" />,
				onClick: (ctx) => ctx.actions.close(),
			},
		],
		[],
	);

	// FORK NOTE: fork tracks rightSidebarOpen via localWorkspaceState (per-workspace persisted state)
	// rather than upstream's v2UserPreferences. Both expose the same boolean; we use fork's source
	// to avoid breaking the existing rightSidebarOpen persistence mechanism.
	const sidebarOpen = localWorkspaceState?.rightSidebarOpen ?? false;
	const { onSidebarResizeDragging, onWorkspaceInteractionStateChange } =
		useBrowserShellInteractionPassthrough({ sidebarOpen });

	useWorkspaceHotkeys({
		store,
		workspaceId,
		matchedPresets,
		executePreset,
		paneRegistry,
	});
	useHotkey("QUICK_OPEN", handleQuickOpen);
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

	return (
		<FileDocumentStoreProvider workspaceId={workspaceId}>
			<ResizablePanelGroup
				direction="horizontal"
				className="min-h-0 min-w-0 flex-1 overflow-auto"
			>
				<ResizablePanel className="min-w-[320px]" defaultSize={80} minSize={30}>
					<div
						className="flex min-h-0 min-w-0 h-full flex-col overflow-hidden"
						data-workspace-id={workspaceId}
					>
						<Workspace<PaneViewerData>
							registry={paneRegistry}
							paneActions={defaultPaneActions}
							contextMenuActions={defaultContextMenuActions}
							renderTabIcon={renderBrowserTabIcon}
							renderTabAccessory={(tab) => (
								<V2NotificationStatusIndicator
									workspaceId={workspaceId}
									sources={getV2NotificationSourcesForTab(tab)}
								/>
							)}
							renderBelowTabBar={() => (
								<V2PresetsBar
									matchedPresets={matchedPresets}
									executePreset={executePreset}
								/>
							)}
							renderAddTabMenu={() => (
								<AddTabMenu
									onAddTerminal={addTerminalTab}
									onAddChat={addChatTab}
									onAddBrowser={addBrowserTab}
									onAddMemo={addMemoTab}
									showPresetsBar={showPresetsBar ?? false}
									onTogglePresetsBar={(enabled) =>
										setShowPresetsBar.mutate({ enabled })
									}
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
							onBeforeCloseTab={(tab) => {
								const dirtyPanes = Object.values(tab.panes).filter((p) => {
									if (p.kind !== "file") return false;
									const filePath = (p.data as FilePaneData).filePath;
									return getDocument(workspaceId, filePath)?.dirty === true;
								});
								const dirtyFileNames = dirtyPanes.map((p) =>
									getBaseName((p.data as FilePaneData).filePath),
								);
								if (dirtyPanes.length === 0) return true;
								const title =
									dirtyPanes.length === 1
										? `Do you want to save the changes you made to ${dirtyFileNames[0]}?`
										: `Do you want to save changes to ${dirtyPanes.length} files?`;
								return new Promise<boolean>((resolve) => {
									alert({
										title,
										description:
											"Your changes will be lost if you don't save them.",
										actions: [
											{
												label: "Save All",
												onClick: async () => {
													for (const pane of dirtyPanes) {
														const filePath = (pane.data as FilePaneData)
															.filePath;
														const doc = getDocument(workspaceId, filePath);
														if (!doc) continue;
														const result = await doc.save();
														if (result.status !== "saved") {
															resolve(false);
															return;
														}
													}
													resolve(true);
												},
											},
											{
												label: "Don't Save",
												variant: "secondary",
												onClick: async () => {
													for (const pane of dirtyPanes) {
														const filePath = (pane.data as FilePaneData)
															.filePath;
														const doc = getDocument(workspaceId, filePath);
														if (doc) await doc.reload();
													}
													resolve(true);
												},
											},
											{
												label: "Cancel",
												variant: "ghost",
												onClick: () => resolve(false),
											},
										],
									});
								});
							}}
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
								workspaceName={workspaceName}
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
				workspaceName={workspaceName}
				includeIgnored={commandPalette.includeIgnored}
				onToggleIncludeIgnored={commandPalette.toggleIncludeIgnored}
			/>
		</FileDocumentStoreProvider>
	);
}
