import type { MosaicBranch } from "react-mosaic-component";
import { VscodeExtensionView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/VscodeExtensionView";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneTitle, PaneToolbarActions } from "../components";

interface VscodeExtensionPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	viewType: string;
	extensionId: string;
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

export function VscodeExtensionPane({
	paneId,
	path,
	tabId,
	viewType,
	extensionId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: VscodeExtensionPaneProps) {
	const paneName = useTabsStore((state) => state.panes[paneId]?.name);
	const setPaneName = useTabsStore((state) => state.setPaneName);

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
				<div className="flex h-full w-full items-center justify-between px-3">
					<div className="flex min-w-0 items-center gap-2">
						<PaneTitle
							name={paneName ?? ""}
							fallback={extensionId}
							onRename={(newName) => setPaneName(paneId, newName)}
						/>
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						onPopOut={handlers.onPopOut}
					/>
				</div>
			)}
		>
			<div className="flex h-full w-full min-h-0 flex-col overflow-hidden">
				<VscodeExtensionView
					viewType={viewType}
					extensionId={extensionId}
					isActive={true}
				/>
			</div>
		</BasePaneWindow>
	);
}
