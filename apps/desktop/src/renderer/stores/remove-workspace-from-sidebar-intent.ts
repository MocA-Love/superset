import { create } from "zustand";

export interface RemoveFromSidebarTarget {
	workspaceId: string;
	workspaceName: string;
	projectId: string;
	isMain: boolean;
	tick: number;
}

interface RemoveFromSidebarIntentState {
	target: RemoveFromSidebarTarget | null;
	request: (target: Omit<RemoveFromSidebarTarget, "tick">) => void;
	clear: () => void;
}

export const useRemoveFromSidebarIntent =
	create<RemoveFromSidebarIntentState>((set) => ({
		target: null,
		request: (target) =>
			set((state) => ({
				target: {
					...target,
					tick: (state.target?.tick ?? 0) + 1,
				},
			})),
		clear: () => set({ target: null }),
	}));
