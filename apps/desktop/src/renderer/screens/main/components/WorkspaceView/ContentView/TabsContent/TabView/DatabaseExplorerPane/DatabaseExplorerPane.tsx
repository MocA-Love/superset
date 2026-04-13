import { Badge } from "@superset/ui/badge";
import { useEffect } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { DatabasesView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/DatabasesView";
import { useDatabaseConnections } from "renderer/stores/database-sidebar";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { SplitPaneOptions, Tab } from "renderer/stores/tabs/types";
import { TabContentContextMenu } from "../../TabContentContextMenu";
import { BasePaneWindow, PaneTitle, PaneToolbarActions } from "../components";

interface DatabaseExplorerPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	splitPaneHorizontal: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: SplitPaneOptions,
	) => void;
	splitPaneVertical: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: SplitPaneOptions,
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	availableTabs: Tab[];
	onMoveToTab: (targetTabId: string) => void;
	onMoveToNewTab: () => void;
	onPopOut?: () => void;
}

export function DatabaseExplorerPane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	splitPaneHorizontal,
	splitPaneVertical,
	removePane,
	setFocusedPane,
	availableTabs,
	onMoveToTab,
	onMoveToNewTab,
	onPopOut,
}: DatabaseExplorerPaneProps) {
	const pane = useTabsStore((state) => state.panes[paneId]);
	const setPaneName = useTabsStore((state) => state.setPaneName);
	const setPaneAutoTitle = useTabsStore((state) => state.setPaneAutoTitle);
	const equalizePaneSplits = useTabsStore((state) => state.equalizePaneSplits);
	const setDatabaseExplorerConnection = useTabsStore(
		(state) => state.setDatabaseExplorerConnection,
	);
	const connections = useDatabaseConnections(workspaceId);

	const connectionId = pane?.databaseExplorer?.connectionId ?? null;
	const currentConnection =
		connections.find((connection) => connection.id === connectionId) ?? null;

	useEffect(() => {
		if (!currentConnection) {
			return;
		}

		setPaneAutoTitle(paneId, `DB: ${currentConnection.label}`);
	}, [currentConnection, paneId, setPaneAutoTitle]);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			splitPaneHorizontal={splitPaneHorizontal}
			splitPaneVertical={splitPaneVertical}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between px-3">
					<div className="flex min-w-0 items-center gap-2">
						<PaneTitle
							name={pane?.name ?? "Database Explorer"}
							fallback="Database Explorer"
							onRename={(newName) => setPaneName(paneId, newName)}
						/>
						{currentConnection ? (
							<Badge variant="outline" className="truncate">
								{currentConnection.label}
							</Badge>
						) : null}
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onSplitPaneOpposite={handlers.onSplitPaneOpposite}
						onClosePane={handlers.onClosePane}
						onPopOut={handlers.onPopOut}
					/>
				</div>
			)}
		>
			<TabContentContextMenu
				onSplitHorizontal={() => splitPaneHorizontal(tabId, paneId, path)}
				onSplitVertical={() => splitPaneVertical(tabId, paneId, path)}
				onSplitWithNewChat={() =>
					splitPaneVertical(tabId, paneId, path, { paneType: "chat" })
				}
				onSplitWithNewBrowser={() =>
					splitPaneVertical(tabId, paneId, path, { paneType: "webview" })
				}
				onEqualizePaneSplits={() => equalizePaneSplits(tabId)}
				onClosePane={() => removePane(paneId)}
				currentTabId={tabId}
				availableTabs={availableTabs}
				onMoveToTab={onMoveToTab}
				onMoveToNewTab={onMoveToNewTab}
				closeLabel="Close Database Explorer"
			>
				<div className="h-full w-full">
					<DatabasesView
						mode="pane"
						selectedConnectionId={connectionId}
						onSelectConnectionId={(nextConnectionId) =>
							setDatabaseExplorerConnection(paneId, nextConnectionId)
						}
						workspaceId={workspaceId}
					/>
				</div>
			</TabContentContextMenu>
		</BasePaneWindow>
	);
}
