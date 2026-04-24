import { useCallback } from "react";
import { ScratchEditor } from "./components/ScratchEditor";
import { ScratchEmpty } from "./components/ScratchEmpty";
import { ScratchTabBar } from "./components/ScratchTabBar";
import { useScratchTabsStore } from "./store";

export function ScratchView() {
	const tabs = useScratchTabsStore((s) => s.tabs);
	const activeTabId = useScratchTabsStore((s) => s.activeTabId);
	const setActive = useScratchTabsStore((s) => s.setActive);
	const closeTab = useScratchTabsStore((s) => s.closeTab);

	const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

	const handleClose = useCallback(
		(id: string) => {
			closeTab(id);
		},
		[closeTab],
	);

	if (tabs.length === 0) {
		return <ScratchEmpty />;
	}

	return (
		<div className="flex h-full w-full flex-col bg-background">
			<ScratchTabBar
				tabs={tabs}
				activeTabId={activeTabId}
				onSelect={setActive}
				onClose={handleClose}
			/>
			<div className="min-h-0 flex-1">
				{activeTab ? (
					<ScratchEditor
						key={activeTab.id}
						absolutePath={activeTab.absolutePath}
					/>
				) : null}
			</div>
		</div>
	);
}
