import { create } from "zustand";

interface BrowserFullscreenState {
	/** paneId currently in HTML fullscreen, or null */
	fullscreenPaneId: string | null;
	setFullscreenPane: (paneId: string | null) => void;
}

export const useBrowserFullscreenStore = create<BrowserFullscreenState>(
	(set) => ({
		fullscreenPaneId: null,
		setFullscreenPane: (paneId) => set({ fullscreenPaneId: paneId }),
	}),
);
