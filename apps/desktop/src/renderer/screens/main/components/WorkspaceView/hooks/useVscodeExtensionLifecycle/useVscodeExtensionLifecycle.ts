import { useEffect, useRef } from "react";
import {
	createPersistentVscodeExtensionHostId,
	createVscodeExtensionPanePersistenceId,
	destroyPersistentVscodeExtensionHost,
	destroyPersistentVscodeExtensionHostsForWorkspace,
} from "renderer/screens/main/components/WorkspaceView/RightSidebar/VscodeExtensionView/runtime";
import { useTabsStore } from "renderer/stores/tabs/store";

function getWorkspaceVscodeExtensionPaneIds(
	state: ReturnType<typeof useTabsStore.getState>,
	workspaceId: string,
): Set<string> {
	const workspaceTabIds = new Set(
		state.tabs
			.filter((tab) => tab.workspaceId === workspaceId)
			.map((tab) => tab.id),
	);

	return new Set(
		Object.entries(state.panes)
			.filter(
				([, pane]) =>
					pane.type === "vscode-extension" && workspaceTabIds.has(pane.tabId),
			)
			.map(([paneId]) => paneId),
	);
}

export function useVscodeExtensionLifecycle(workspaceId: string) {
	const previousPaneIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const state = useTabsStore.getState();
		previousPaneIdsRef.current = getWorkspaceVscodeExtensionPaneIds(
			state,
			workspaceId,
		);

		const unsubscribe = useTabsStore.subscribe((nextState) => {
			const currentPaneIds = getWorkspaceVscodeExtensionPaneIds(
				nextState,
				workspaceId,
			);

			for (const previousPaneId of previousPaneIdsRef.current) {
				if (!currentPaneIds.has(previousPaneId)) {
					destroyPersistentVscodeExtensionHost(
						createPersistentVscodeExtensionHostId(
							workspaceId,
							createVscodeExtensionPanePersistenceId(previousPaneId),
						),
					);
				}
			}

			previousPaneIdsRef.current = currentPaneIds;
		});

		return () => {
			unsubscribe();
			destroyPersistentVscodeExtensionHostsForWorkspace(workspaceId);
		};
	}, [workspaceId]);
}
