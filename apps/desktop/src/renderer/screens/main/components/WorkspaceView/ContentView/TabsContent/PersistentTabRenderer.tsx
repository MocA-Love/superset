import { useMemo } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import { extractPaneIdsFromLayout } from "renderer/stores/tabs/utils";
import { TabView } from "./TabView";

interface PersistentTabRendererProps {
	isWorkspaceActive: boolean;
	tabs: Tab[];
	activeTabId: string | null;
}

/**
 * Renders workspace tabs, keeping tabs with embedded views mounted when inactive.
 * Keeping these tabs mounted preserves scroll position, search state, cursor,
 * subscriptions, and avoids forcing view re-resolution when the tab returns to
 * focus.
 */
export function PersistentTabRenderer({
	isWorkspaceActive,
	tabs,
	activeTabId,
}: PersistentTabRendererProps) {
	const panes = useTabsStore((s) => s.panes);

	const tabsWithPersistentViews = useMemo(() => {
		const ids = new Set<string>();
		for (const tab of tabs) {
			const paneIds = extractPaneIdsFromLayout(tab.layout);
			if (
				paneIds.some((id) => {
					const type = panes[id]?.type;
					return (
						type === "webview" ||
						type === "vscode-extension" ||
						type === "reference-graph" ||
						type === "file-viewer"
					);
				})
			) {
				ids.add(tab.id);
			}
		}
		return ids;
	}, [tabs, panes]);

	return (
		<>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				const hasPersistentView = tabsWithPersistentViews.has(tab.id);

				if (!hasPersistentView && !isActive) return null;

				return (
					<div
						key={tab.id}
						className="flex flex-1 min-h-0 w-full h-full overflow-hidden"
						style={
							isActive
								? undefined
								: {
										position: "fixed",
										left: -9999,
										top: -9999,
										width: "100vw",
										height: "100vh",
										pointerEvents: "none",
									}
						}
					>
						<TabView tab={tab} isWorkspaceActive={isWorkspaceActive} />
					</div>
				);
			})}
		</>
	);
}
