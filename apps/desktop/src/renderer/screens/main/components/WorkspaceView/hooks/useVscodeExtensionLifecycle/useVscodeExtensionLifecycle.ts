import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	createPersistentVscodeExtensionHostId,
	createVscodeExtensionPanePersistenceId,
	destroyPersistentVscodeExtensionHost,
	destroyPersistentVscodeExtensionHostsForWorkspace,
} from "renderer/screens/main/components/WorkspaceView/RightSidebar/VscodeExtensionView/runtime";
import { useTabsStore } from "renderer/stores/tabs/store";

function getWorkspaceVscodeExtensionPanes(
	state: ReturnType<typeof useTabsStore.getState>,
	workspaceId: string,
): Map<
	string,
	NonNullable<ReturnType<typeof useTabsStore.getState>["panes"][string]>
> {
	const workspaceTabIds = new Set(
		state.tabs
			.filter((tab) => tab.workspaceId === workspaceId)
			.map((tab) => tab.id),
	);

	return new Map(
		Object.entries(state.panes).filter(
			([, pane]) =>
				pane.type === "vscode-extension" && workspaceTabIds.has(pane.tabId),
		),
	);
}

export function useVscodeExtensionLifecycle(workspaceId: string) {
	const previousPanesRef = useRef<
		Map<
			string,
			NonNullable<ReturnType<typeof useTabsStore.getState>["panes"][string]>
		>
	>(new Map());
	const disposeWebviewMutation =
		electronTrpc.vscodeExtensions.disposeWebview.useMutation();
	const disposeWebviewRef = useRef(disposeWebviewMutation.mutate);
	disposeWebviewRef.current = disposeWebviewMutation.mutate;

	useEffect(() => {
		const state = useTabsStore.getState();
		previousPanesRef.current = getWorkspaceVscodeExtensionPanes(
			state,
			workspaceId,
		);

		const unsubscribe = useTabsStore.subscribe((nextState) => {
			const currentPanes = getWorkspaceVscodeExtensionPanes(
				nextState,
				workspaceId,
			);

			for (const [previousPaneId, previousPane] of previousPanesRef.current) {
				if (!currentPanes.has(previousPaneId)) {
					destroyPersistentVscodeExtensionHost(
						createPersistentVscodeExtensionHostId(
							workspaceId,
							createVscodeExtensionPanePersistenceId(previousPaneId),
						),
					);
					if (
						previousPane.vscodeExtension?.source === "panel" &&
						previousPane.vscodeExtension.sessionId
					) {
						disposeWebviewRef.current({
							viewId: previousPane.vscodeExtension.sessionId,
						});
					}
				}
			}

			previousPanesRef.current = currentPanes;
		});

		return () => {
			unsubscribe();
			destroyPersistentVscodeExtensionHostsForWorkspace(workspaceId);
		};
	}, [workspaceId]);
}
