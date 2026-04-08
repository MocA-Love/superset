import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceId } from "../WorkspaceIdContext";

/**
 * Listens for diff open requests from VS Code extensions
 * (vscode.diff command calls) and opens them in Superset's file viewer.
 */
export function useVscodeDiffSync() {
	const workspaceId = useWorkspaceId();
	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);

	electronTrpc.vscodeExtensions.subscribeDiff.useSubscription(
		{ workspaceId: workspaceId ?? undefined },
		{
			enabled: !!workspaceId,
			onData: (data) => {
				if (!workspaceId) return;
				addFileViewerPane(workspaceId, {
					filePath: data.rightUri,
					viewMode: "diff",
					diffCategory: "unstaged",
				});
			},
		},
	);
}
