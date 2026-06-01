import type { RendererContext } from "@superset/panes";
import { GitGraphView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/GitGraphView";
import { WorkspaceIdProvider } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import type { GitGraphPaneData, PaneViewerData } from "../../../../types";

interface GitGraphPaneProps {
	context: RendererContext<PaneViewerData>;
	workspaceId: string;
}

export function GitGraphPane({ context, workspaceId }: GitGraphPaneProps) {
	const data = context.pane.data as GitGraphPaneData;

	return (
		<WorkspaceIdProvider value={workspaceId}>
			<GitGraphView
				worktreePath={data.worktreePath}
				workspaceId={workspaceId}
			/>
		</WorkspaceIdProvider>
	);
}
