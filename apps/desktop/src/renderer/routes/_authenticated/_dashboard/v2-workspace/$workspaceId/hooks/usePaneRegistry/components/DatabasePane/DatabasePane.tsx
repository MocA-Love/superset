import type { RendererContext } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { DatabasesView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/DatabasesView";
import { WorkspaceIdProvider } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import type { DatabasePaneData, PaneViewerData } from "../../../../types";

interface DatabasePaneProps {
	context: RendererContext<PaneViewerData>;
	workspaceId: string;
}

export function DatabasePane({ context, workspaceId }: DatabasePaneProps) {
	const data = context.pane.data as DatabasePaneData;
	const workspaceQuery = workspaceTrpc.workspace.get.useQuery({
		id: workspaceId,
	});

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
				worktreePathOverride={workspaceQuery.data?.worktreePath}
			/>
		</WorkspaceIdProvider>
	);
}
