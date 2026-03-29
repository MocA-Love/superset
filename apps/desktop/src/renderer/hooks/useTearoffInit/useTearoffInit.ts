import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import type { Pane } from "shared/tabs-types";

// Cached at module load from preload-injected data
const _cachedWindowId: string | null =
	typeof window !== "undefined" ? window.App?.tearoffWindowId ?? null : null;

export function getTearoffWindowId(): string | null {
	return _cachedWindowId;
}

export function isTearoffWindow(): boolean {
	return _cachedWindowId !== null;
}

export function useTearoffInit() {
	const initialized = useRef(false);
	const navigate = useNavigate();
	const tabs = useTabsStore((s) => s.tabs);

	// Navigate to the workspace for the tearoff tab
	useEffect(() => {
		if (!_cachedWindowId || initialized.current || tabs.length === 0) return;
		initialized.current = true;
		const tab = tabs[0];
		navigate({ to: `/workspace/${tab.workspaceId}`, replace: true });
	}, [tabs, navigate]);

	// Return ALL tabs to main window when this tearoff window closes
	useEffect(() => {
		if (!_cachedWindowId) return;
		const handleBeforeUnload = () => {
			const state = useTabsStore.getState();
			if (state.tabs.length === 0) return;

			// Collect all tabs + their panes into a single message
			const tabsWithPanes = state.tabs.map((tab) => {
				const panes: Record<string, Pane> = {};
				for (const [id, pane] of Object.entries(state.panes)) {
					if (pane.tabId === tab.id) {
						panes[id] = pane;
					}
				}
				return { tab, panes };
			});

			// Send as ONE message to avoid race conditions
			window.ipcRenderer.send("tearoff-return-tabs", tabsWithPanes);
		};
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, []);
}

export function useReturnedTabListener() {
	useEffect(() => {
		if (isTearoffWindow()) return;
		const handler = (
			entries: Array<{ tab: unknown; panes: Record<string, unknown> }>,
		) => {
			const store = useTabsStore.getState();
			const existingTabIds = new Set(store.tabs.map((t) => t.id));

			for (const entry of entries) {
				const tab = entry.tab as Tab;
				// Skip if tab already exists (prevent duplicates)
				if (existingTabIds.has(tab.id)) continue;
				const panes = entry.panes as Record<string, Pane>;
				store.hydrateReturnedTab(tab, panes);
				existingTabIds.add(tab.id);
			}
		};
		window.ipcRenderer.on("tearoff-tab-returned", handler);
		return () => {
			window.ipcRenderer.off("tearoff-tab-returned", handler);
		};
	}, []);
}
