import { useEffect, useRef } from "react";
import {
	createVscodeExtensionPanePersistenceId,
	destroyPersistentVscodeExtensionHost,
} from "renderer/screens/main/components/WorkspaceView/RightSidebar/VscodeExtensionView/runtime";
import { useTabsStore } from "renderer/stores/tabs/store";

export function useVscodeExtensionLifecycle() {
	const previousPaneIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const state = useTabsStore.getState();
		previousPaneIdsRef.current = new Set(
			Object.entries(state.panes)
				.filter(([, pane]) => pane.type === "vscode-extension")
				.map(([paneId]) => paneId),
		);

		return useTabsStore.subscribe((nextState) => {
			const currentPaneIds = new Set(
				Object.entries(nextState.panes)
					.filter(([, pane]) => pane.type === "vscode-extension")
					.map(([paneId]) => paneId),
			);

			for (const previousPaneId of previousPaneIdsRef.current) {
				if (!currentPaneIds.has(previousPaneId)) {
					destroyPersistentVscodeExtensionHost(
						createVscodeExtensionPanePersistenceId(previousPaneId),
					);
				}
			}

			previousPaneIdsRef.current = currentPaneIds;
		});
	}, []);
}
