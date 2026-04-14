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
				// leftUri がファイルシステムパスかつ rightUri と異なる場合はリネーム/移動。
				// git URI (例: git:///path?ref) の場合は unstaged diff として git が差分を解決するため oldPath 不要。
				const leftIsFilePath =
					data.leftUri.startsWith("/") || data.leftUri.startsWith("file://");
				const isRename = leftIsFilePath && data.leftUri !== data.rightUri;
				addFileViewerPane(workspaceId, {
					filePath: data.rightUri,
					viewMode: "diff",
					diffCategory: "unstaged",
					useRightSidebarOpenViewWidth: true,
					...(isRename ? { oldPath: data.leftUri } : {}),
				});
			},
		},
	);
}
