import { create } from "zustand";

interface TabBulkSelectionState {
	workspaceId: string | null;
	selectedTabIds: Set<string>;
}

interface TabBulkSelectionActions {
	enterBulkMode: (workspaceId: string, initialTabId?: string) => void;
	exitBulkMode: () => void;
	toggleSelect: (tabId: string) => void;
	setSelection: (tabIds: string[]) => void;
	removeFromSelection: (tabId: string) => void;
	pruneSelection: (validTabIds: string[]) => void;
}

export const useTabBulkSelectionStore = create<
	TabBulkSelectionState & TabBulkSelectionActions
>((set) => ({
	workspaceId: null,
	selectedTabIds: new Set<string>(),
	enterBulkMode: (workspaceId, initialTabId) =>
		set(() => {
			const next = new Set<string>();
			if (initialTabId) next.add(initialTabId);
			return { workspaceId, selectedTabIds: next };
		}),
	exitBulkMode: () =>
		set({ workspaceId: null, selectedTabIds: new Set<string>() }),
	toggleSelect: (tabId) =>
		set((state) => {
			const next = new Set(state.selectedTabIds);
			if (next.has(tabId)) next.delete(tabId);
			else next.add(tabId);
			return { selectedTabIds: next };
		}),
	setSelection: (tabIds) => set({ selectedTabIds: new Set(tabIds) }),
	removeFromSelection: (tabId) =>
		set((state) => {
			if (!state.selectedTabIds.has(tabId)) return state;
			const next = new Set(state.selectedTabIds);
			next.delete(tabId);
			return { selectedTabIds: next };
		}),
	pruneSelection: (validTabIds) =>
		set((state) => {
			if (state.selectedTabIds.size === 0) return state;
			const valid = new Set(validTabIds);
			let changed = false;
			const next = new Set<string>();
			for (const id of state.selectedTabIds) {
				if (valid.has(id)) next.add(id);
				else changed = true;
			}
			if (!changed) return state;
			return { selectedTabIds: next };
		}),
}));
