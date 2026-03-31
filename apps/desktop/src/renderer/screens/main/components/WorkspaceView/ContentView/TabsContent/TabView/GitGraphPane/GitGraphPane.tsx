import type { MosaicBranch } from "react-mosaic-component";
import { GitGraphView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/GitGraphView";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";

interface GitGraphPaneProps {
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
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
}

export function GitGraphPane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: GitGraphPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const worktreePath = pane?.gitGraph?.worktreePath;

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center px-2">
					<span className="truncate text-sm text-muted-foreground">
						Git Graph
					</span>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						onPopOut={handlers.onPopOut}
					/>
				</div>
			)}
		>
			{worktreePath ? (
				<GitGraphView worktreePath={worktreePath} workspaceId={workspaceId} />
			) : (
				<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
					No workspace path
				</div>
			)}
		</BasePaneWindow>
	);
}
