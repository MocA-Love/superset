import type { Tab } from "renderer/stores/tabs/types";
import { TabView } from "./TabView";

interface PersistentTabRendererProps {
	tabs: Tab[];
	activeTabId: string | null;
}

/**
 * Renders all workspace tabs simultaneously, hiding inactive ones with CSS.
 *
 * Electron's <webview> tag reloads its content whenever it is reparented in the
 * DOM (moved from one parent element to another). The previous approach rendered
 * only the active tab, which caused BrowserPane to unmount on every tab switch
 * and park the webview in a hidden container (DOM reparent) — triggering a hard
 * reload each time the user switched back.
 *
 * By keeping every tab mounted and toggling visibility via `display`, webview
 * elements stay in their original DOM parent and never reparent, eliminating the
 * reload.
 */
export function PersistentTabRenderer({
	tabs,
	activeTabId,
}: PersistentTabRendererProps) {
	return (
		<>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
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
