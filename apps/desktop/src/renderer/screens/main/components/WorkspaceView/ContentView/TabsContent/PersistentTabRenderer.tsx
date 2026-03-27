import { useMemo } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import { extractPaneIdsFromLayout } from "renderer/stores/tabs/utils";
import { TabView } from "./TabView";

interface PersistentTabRendererProps {
	tabs: Tab[];
	activeTabId: string | null;
}

/**
 * Renders workspace tabs, keeping only those that contain a browser (webview)
 * pane mounted when inactive. Tabs without webviews are unmounted normally.
 *
 * Electron's <webview> tag reloads its content whenever it is reparented in the
 * DOM. By keeping webview-containing tabs mounted (but off-screen), webview
 * elements stay in their original DOM parent and never reparent, eliminating
 * the reload. Non-webview tabs (terminals, chat, files) can safely unmount and
 * remount without data loss.
 */
export function PersistentTabRenderer({
	tabs,
	activeTabId,
}: PersistentTabRendererProps) {
	const panes = useTabsStore((s) => s.panes);

	const tabsWithWebview = useMemo(() => {
		const ids = new Set<string>();
		for (const tab of tabs) {
			const paneIds = extractPaneIdsFromLayout(tab.layout);
			if (paneIds.some((id) => panes[id]?.type === "webview")) {
				ids.add(tab.id);
			}
		}
		return ids;
	}, [tabs, panes]);

	return (
		<>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				const hasWebview = tabsWithWebview.has(tab.id);

				// Tabs without webviews: only render when active (original behavior)
				if (!hasWebview && !isActive) return null;

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
						<TabView tab={tab} />
					</div>
				);
			})}
		</>
	);
}
