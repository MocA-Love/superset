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

	// Return tab to main window when this tearoff window closes
	useEffect(() => {
		if (!_cachedWindowId) return;
		const handleBeforeUnload = () => {
			const state = useTabsStore.getState();
			if (state.tabs.length === 0) return;
			const tab = state.tabs[0];
			const panes: Record<string, Pane> = {};
			for (const [id, pane] of Object.entries(state.panes)) {
				if (pane.tabId === tab.id) {
					panes[id] = pane;
				}
			}
			window.ipcRenderer.send("tearoff-return-tab", { tab, panes });
		};
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, []);
}

export function useReturnedTabListener() {
	useEffect(() => {
		if (isTearoffWindow()) return;
		const handler = (data: { tab: unknown; panes: Record<string, unknown> }) => {
			const tab = data.tab as Tab;
			const panes = data.panes as Record<string, Pane>;
			useTabsStore.getState().hydrateReturnedTab(tab, panes);
		};
		window.ipcRenderer.on("tearoff-tab-returned", handler);
		return () => {
			window.ipcRenderer.off("tearoff-tab-returned", handler);
		};
	}, []);
}
