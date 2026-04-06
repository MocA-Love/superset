import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceId } from "../WorkspaceIdContext";

/**
 * Listens for file open requests from VS Code extensions
 * (showTextDocument calls) and opens them in Superset's file viewer.
 */
export function useVscodeOpenFileSync() {
	const workspaceId = useWorkspaceId();
	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);

	electronTrpc.vscodeExtensions.subscribeOpenFile.useSubscription(
		{ workspaceId: workspaceId ?? undefined },
		{
			enabled: !!workspaceId,
			onData: (data) => {
				if (!workspaceId) return;
				addFileViewerPane(workspaceId, {
					filePath: data.filePath,
					line: data.line,
					viewMode: "raw",
				});
			},
		},
	);
}
