import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "shared/tabs-types";
import { useWorkspaceId } from "../WorkspaceIdContext";

/**
 * Derive extensionId from extensionPath (format: publisher.name-version)
 * e.g. "/home/user/.vscode/extensions/anthropic.claude-code-1.2.3" -> "anthropic.claude-code"
 */
function extensionIdFromPath(extensionPath: string): string | null {
	const lastSep = Math.max(
		extensionPath.lastIndexOf("/"),
		extensionPath.lastIndexOf("\\"),
	);
	const dirName =
		lastSep >= 0 ? extensionPath.slice(lastSep + 1) : extensionPath;
	const match = dirName.match(/^([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/);
	return match?.[1] ?? null;
}

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
				const { viewType, title, extensionPath } = event.data as {
					viewType: string;
					title: string;
					panelId: string;
					extensionPath?: string;
				};

				// Derive extensionId from extensionPath or fall back to viewType
				const extensionId =
					(extensionPath ? extensionIdFromPath(extensionPath) : null) ??
					viewType;

				// Dedup: skip if a vscode-extension pane with the same viewType already exists
				const panes = useTabsStore.getState().panes;
				const alreadyExists = Object.values(panes).some(
					(pane: Pane) =>
						pane.type === "vscode-extension" &&
						pane.vscodeExtension?.viewType === viewType,
				);
				if (alreadyExists) {
					return;
				}

				addVscodeExtensionTab(
					workspaceId,
					extensionId,
					viewType,
					title || "Extension Panel",
				);
			}
		},
	});
}
