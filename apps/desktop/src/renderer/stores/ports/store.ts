import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

const DEFAULT_LIST_HEIGHT = 288; // 18rem (max-h-72)
const MIN_LIST_HEIGHT = 80;
const MAX_LIST_HEIGHT = 600;

interface PortsState {
	isListCollapsed: boolean;
	/** Height of the ports list in pixels (user-resizable). */
	listHeight: number;
	/** When true, only ports with a label from ports.json are shown. */
	showConfiguredOnly: boolean;

	setListCollapsed: (collapsed: boolean) => void;
	toggleListCollapsed: () => void;
	setListHeight: (height: number) => void;
	setShowConfiguredOnly: (value: boolean) => void;
}

export { MIN_LIST_HEIGHT, MAX_LIST_HEIGHT };

export const usePortsStore = create<PortsState>()(
	devtools(
		persist(
			(set, get) => ({
				isListCollapsed: false,
				listHeight: DEFAULT_LIST_HEIGHT,
				showConfiguredOnly: false,

				setListCollapsed: (collapsed) => set({ isListCollapsed: collapsed }),

				toggleListCollapsed: () =>
					set({ isListCollapsed: !get().isListCollapsed }),

				setListHeight: (height) =>
					set({
						listHeight: Math.max(
							MIN_LIST_HEIGHT,
							Math.min(MAX_LIST_HEIGHT, height),
						),
					}),

				setShowConfiguredOnly: (value) => set({ showConfiguredOnly: value }),
			}),
			{
				name: "ports-store",
				partialize: (state) => ({
					isListCollapsed: state.isListCollapsed,
					listHeight: state.listHeight,
					showConfiguredOnly: state.showConfiguredOnly,
				}),
			},
		),
		{ name: "PortsStore" },
	),
);
