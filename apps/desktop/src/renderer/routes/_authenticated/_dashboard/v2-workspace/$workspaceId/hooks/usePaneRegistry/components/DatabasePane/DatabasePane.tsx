import type { RendererContext } from "@superset/panes";
import { DatabasesView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/DatabasesView";
import { WorkspaceIdProvider } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import type { DatabasePaneData, PaneViewerData } from "../../../../types";

interface DatabasePaneProps {
	context: RendererContext<PaneViewerData>;
	workspaceId: string;
}

export function DatabasePane({ context, workspaceId }: DatabasePaneProps) {
	const data = context.pane.data as DatabasePaneData;

	return (
		<WorkspaceIdProvider value={workspaceId}>
			<DatabasesView
				mode="pane"
				selectedConnectionId={data.connectionId}
				onSelectConnectionId={(connectionId) =>
					context.actions.updateData({
						...data,
						connectionId,
					} as PaneViewerData)
				}
				workspaceId={workspaceId}
			/>
		</WorkspaceIdProvider>
	);
}
