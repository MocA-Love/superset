import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceId } from "../WorkspaceIdContext";

/**
 * Listens for VS Code extension panel creation events and
 * automatically opens them as tabs in the current workspace.
 */
export function useVscodeExtensionPanelSync() {
	const workspaceId = useWorkspaceId();
	const addVscodeExtensionTab = useTabsStore((s) => s.addVscodeExtensionTab);

	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(undefined, {
		enabled: !!workspaceId,
		onData: (event) => {
			if (
				event.type === "panel-created" &&
				workspaceId &&
				typeof event.data === "object" &&
				event.data !== null
			) {
				const { viewType, title, panelId } = event.data as {
					viewType: string;
					title: string;
					panelId: string;
				};
				addVscodeExtensionTab(
					workspaceId,
					viewType,
					viewType,
					title || "Extension Panel",
				);
			}
		},
	});
}
