import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import {
	createFileRoute,
	useMatchRoute,
	useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import { CommandPaletteHost } from "renderer/commandPalette";
import { useBrowserFullscreenHandler } from "renderer/hooks/useBrowserFullscreenHandler";
import { useBrowserNewWindowHandler } from "renderer/hooks/useBrowserNewWindowHandler";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import {
	isTearoffWindow,
	useReturnedTabListener,
	useTearoffInit,
} from "renderer/hooks/useTearoffInit";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DashboardSidebar } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar";
import { DashboardSidebarDeleteDialog } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarDeleteDialog";
import { RemoveFromSidebarDialog } from "renderer/routes/_authenticated/_dashboard/components/RemoveFromSidebarDialog";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useDevSeedV2Sidebar } from "renderer/routes/_authenticated/hooks/useDevSeedV2Sidebar";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { ResizablePanel } from "renderer/screens/main/components/ResizablePanel";
import { WorkspaceSidebar } from "renderer/screens/main/components/WorkspaceSidebar";
import { DeleteWorkspaceDialog } from "renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/components";
import { useOpenNewWorkspaceModal } from "renderer/stores/new-workspace-modal";
import {
	COLLAPSED_WORKSPACE_SIDEBAR_WIDTH,
	DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
	MAX_WORKSPACE_SIDEBAR_WIDTH,
	useWorkspaceSidebarStore,
} from "renderer/stores/workspace-sidebar-state";
import { AddRepositoryModals } from "./components/AddRepositoryModals";
import { CrossVersionMismatchState } from "./components/CrossVersionMismatchState";
import { KeepAliveWorkspaces } from "./components/KeepAliveWorkspaces";
import { TopBar } from "./components/TopBar";

export const Route = createFileRoute("/_authenticated/_dashboard")({
	component: DashboardLayout,
});

type DeleteTarget =
	| {
			version: "v1";
			workspaceId: string;
			workspaceName: string;
			workspaceType: "worktree" | "branch";
	  }
	| {
			version: "v2";
			workspaceId: string;
			workspaceName: string;
			open: boolean;
	  };

function DashboardLayout() {
	const navigate = useNavigate();
	const openNewWorkspaceModal = useOpenNewWorkspaceModal();
	const isV2CloudEnabled = useIsV2CloudEnabled();
	const collections = useCollections();
	const { removeWorkspaceFromSidebar } = useDashboardSidebarState();
	useDevSeedV2Sidebar();
	// Get current workspace from route to pre-select project in new workspace modal
	const matchRoute = useMatchRoute();
	const currentWorkspaceMatch = matchRoute({
		to: "/workspace/$workspaceId",
		fuzzy: true,
	});
	const currentWorkspaceId =
		currentWorkspaceMatch !== false ? currentWorkspaceMatch.workspaceId : null;

	// #4211: when active version (v1 vs v2) doesn't match the current
	// workspace route, swap KeepAliveWorkspaces for a pick-workspace
	// placeholder so users land on the version-correct sidebar.
	const v2WorkspaceMatch = matchRoute({
		to: "/v2-workspace/$workspaceId",
		fuzzy: true,
	});
	const currentV2WorkspaceId =
		v2WorkspaceMatch !== false ? v2WorkspaceMatch.workspaceId : null;
	const onV1WorkspaceRoute = currentWorkspaceMatch !== false;
	const onV2WorkspaceRoute = v2WorkspaceMatch !== false;
	const versionMismatch =
		(isV2CloudEnabled && onV1WorkspaceRoute) ||
		(!isV2CloudEnabled && onV2WorkspaceRoute);

	// Q3:B — scratch route hides the workspace sidebar so a dropped file opens
	// as a focused editor with no project chrome around it.
	const isScratchRoute = matchRoute({ to: "/scratch", fuzzy: true }) !== false;

	const { data: currentWorkspace } = electronTrpc.workspaces.get.useQuery(
		{ id: currentWorkspaceId ?? "" },
		{ enabled: !!currentWorkspaceId },
	);

	const { data: currentV2Workspaces = [] } = useLiveQuery(
		(q) =>
			q
				.from({ workspaces: collections.v2Workspaces })
				.where(({ workspaces }) =>
					eq(workspaces.id, currentV2WorkspaceId ?? ""),
				),
		[collections, currentV2WorkspaceId],
	);
	const currentV2Workspace =
		currentV2WorkspaceId != null ? (currentV2Workspaces[0] ?? null) : null;

	const {
		isOpen: isWorkspaceSidebarOpen,
		toggleCollapsed: toggleWorkspaceSidebarCollapsed,
		setOpen: setWorkspaceSidebarOpen,
		width: workspaceSidebarWidth,
		setWidth: setWorkspaceSidebarWidth,
		isResizing: isWorkspaceSidebarResizing,
		setIsResizing: setWorkspaceSidebarIsResizing,
		isCollapsed: isWorkspaceSidebarCollapsed,
	} = useWorkspaceSidebarStore();

	// Global hotkeys for dashboard
	useHotkey("OPEN_SETTINGS", () => navigate({ to: "/settings/account" }));
	useHotkey("SHOW_HOTKEYS", () => navigate({ to: "/settings/keyboard" }));
	useHotkey("TOGGLE_WORKSPACE_SIDEBAR", () => {
		if (!isWorkspaceSidebarOpen) {
			setWorkspaceSidebarOpen(true);
		} else {
			toggleWorkspaceSidebarCollapsed();
		}
	});
	useHotkey("NEW_WORKSPACE", () =>
		openNewWorkspaceModal(currentWorkspace?.projectId),
	);

	// Global listener for target="_blank" / window.open in any browser pane.
	// Must live here (always-mounted) because webviews persist in a hidden
	// container even when their BrowserPane component is unmounted.
	useBrowserNewWindowHandler();
	useBrowserFullscreenHandler();
	useTearoffInit();
	useReturnedTabListener();
	const isTearoff = isTearoffWindow();

	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

	useHotkey(
		"CLOSE_WORKSPACE",
		() => {
			if (currentWorkspaceId && currentWorkspace) {
				setDeleteTarget({
					workspaceId: currentWorkspaceId,
					workspaceName: currentWorkspace.name,
					workspaceType: currentWorkspace.type,
					version: "v1",
				});
				return;
			}

			if (
				currentV2WorkspaceId &&
				currentV2Workspace &&
				currentV2Workspace.type !== "main"
			) {
				setDeleteTarget({
					workspaceId: currentV2WorkspaceId,
					workspaceName: currentV2Workspace.name || currentV2Workspace.branch,
					version: "v2",
					open: true,
				});
			}
		},
		{
			enabled:
				(!!currentWorkspaceId && !!currentWorkspace) ||
				(!!currentV2WorkspaceId &&
					!!currentV2Workspace &&
					currentV2Workspace.type !== "main"),
		},
	);

	return (
		// FORK NOTE: keep custom outer wrapper, isTearoff / isScratchRoute
		// conditional rendering and <KeepAliveWorkspaces />.
		<div className="flex h-full w-full overflow-hidden bg-tertiary">
			<CommandPaletteHost />
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{!isTearoff && <TopBar />}
				<div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
					{!isTearoff && !isScratchRoute && isWorkspaceSidebarOpen && (
						<ResizablePanel
							width={workspaceSidebarWidth}
							onWidthChange={setWorkspaceSidebarWidth}
							isResizing={isWorkspaceSidebarResizing}
							onResizingChange={setWorkspaceSidebarIsResizing}
							minWidth={COLLAPSED_WORKSPACE_SIDEBAR_WIDTH}
							maxWidth={MAX_WORKSPACE_SIDEBAR_WIDTH}
							handleSide="right"
							clampWidth={false}
							onDoubleClickHandle={() =>
								setWorkspaceSidebarWidth(DEFAULT_WORKSPACE_SIDEBAR_WIDTH)
							}
						>
							{isV2CloudEnabled ? (
								<DashboardSidebar isCollapsed={isWorkspaceSidebarCollapsed()} />
							) : (
								<WorkspaceSidebar
									isCollapsed={isWorkspaceSidebarCollapsed()}
									activeProjectId={currentWorkspace?.projectId ?? null}
									activeProjectName={currentWorkspace?.project?.name ?? null}
								/>
							)}
						</ResizablePanel>
					)}
					<div className="flex flex-1 min-h-0 min-w-0">
						{versionMismatch ? (
							<CrossVersionMismatchState />
						) : (
							<KeepAliveWorkspaces />
						)}
					</div>
				</div>
			</div>
			<div id="workspace-right-sidebar-slot" className="flex h-full shrink-0" />
			<AddRepositoryModals />
			<RemoveFromSidebarDialog />
			{deleteTarget?.version === "v1" && (
				<DeleteWorkspaceDialog
					workspaceId={deleteTarget.workspaceId}
					workspaceName={deleteTarget.workspaceName}
					workspaceType={deleteTarget.workspaceType}
					open={true}
					onOpenChange={(open) => {
						if (!open) setDeleteTarget(null);
					}}
				/>
			)}
			{deleteTarget?.version === "v2" && (
				<DashboardSidebarDeleteDialog
					workspaceId={deleteTarget.workspaceId}
					workspaceName={deleteTarget.workspaceName}
					open={deleteTarget.open}
					onOpenChange={(open) => {
						setDeleteTarget((target) =>
							target?.version === "v2" ? { ...target, open } : target,
						);
					}}
					onDeleted={() => {
						removeWorkspaceFromSidebar(deleteTarget.workspaceId);
						setDeleteTarget(null);
					}}
				/>
			)}
		</div>
	);
}
