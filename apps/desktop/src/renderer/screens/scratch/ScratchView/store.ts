import { create } from "zustand";
import type { ScratchTab } from "./components/ScratchTabBar";

interface ScratchTabsState {
	tabs: ScratchTab[];
	activeTabId: string | null;
	openPaths: (absolutePaths: string[]) => void;
	setActive: (id: string) => void;
	closeTab: (id: string) => void;
	reset: () => void;
}

function makeTabId(absolutePath: string): string {
	// One tab per path, deduped. The path itself is the stable key.
	return `scratch:${absolutePath}`;
}

/**
 * Q1:B — scratch tabs live only in renderer memory. There is no persistence
 * across reloads or app restarts. Closing all tabs bounces the user back to
 * the workspace picker via ScratchEmpty.
 */
export const useScratchTabsStore = create<ScratchTabsState>((set) => ({
	tabs: [],
	activeTabId: null,
	openPaths: (absolutePaths) => {
		if (absolutePaths.length === 0) return;
		set((state) => {
			const existingIds = new Set(state.tabs.map((t) => t.id));
			const additions: ScratchTab[] = [];
			for (const p of absolutePaths) {
				const id = makeTabId(p);
				if (!existingIds.has(id)) {
					additions.push({ id, absolutePath: p });
					existingIds.add(id);
				}
			}
			const tabs = [...state.tabs, ...additions];
			const lastPath = absolutePaths[absolutePaths.length - 1];
			const lastId = makeTabId(lastPath);
			return { tabs, activeTabId: lastId };
		});
	},
	setActive: (id) => set({ activeTabId: id }),
	closeTab: (id) =>
		set((state) => {
			const idx = state.tabs.findIndex((t) => t.id === id);
			if (idx < 0) return state;
			const tabs = [...state.tabs.slice(0, idx), ...state.tabs.slice(idx + 1)];
			let activeTabId = state.activeTabId;
			if (activeTabId === id) {
				const nextIdx = Math.min(idx, tabs.length - 1);
				activeTabId = tabs[nextIdx]?.id ?? null;
			}
			return { tabs, activeTabId };
		}),
	reset: () => set({ tabs: [], activeTabId: null }),
}));
