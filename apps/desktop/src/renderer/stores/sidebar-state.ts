import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export enum SidebarMode {
	Tabs = "tabs",
	Changes = "changes",
}

export enum RightSidebarTab {
	Changes = "changes",
	Docker = "docker",
	Files = "files",
	Search = "search",
	Problems = "problems",
	Databases = "databases",
}

export const DEFAULT_RIGHT_SIDEBAR_TAB_ORDER = [
	RightSidebarTab.Changes,
	RightSidebarTab.Docker,
	RightSidebarTab.Files,
	RightSidebarTab.Search,
	RightSidebarTab.Problems,
	RightSidebarTab.Databases,
] as const satisfies RightSidebarTab[];

export const DEFAULT_SIDEBAR_WIDTH = 250;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 800;

const RIGHT_SIDEBAR_TAB_VALUES = new Set<RightSidebarTab>(
	Object.values(RightSidebarTab),
);

function isRightSidebarTab(value: unknown): value is RightSidebarTab {
	return (
		typeof value === "string" &&
		RIGHT_SIDEBAR_TAB_VALUES.has(value as RightSidebarTab)
	);
}

export function normalizeRightSidebarTabOrder(
	order: readonly RightSidebarTab[] | undefined,
): RightSidebarTab[] {
	const normalizedOrder: RightSidebarTab[] = [];
	const seen = new Set<RightSidebarTab>();

	for (const tab of order ?? []) {
		if (!isRightSidebarTab(tab) || seen.has(tab)) {
			continue;
		}

		seen.add(tab);
		normalizedOrder.push(tab);
	}

	for (const tab of DEFAULT_RIGHT_SIDEBAR_TAB_ORDER) {
		if (seen.has(tab)) {
			continue;
		}

		seen.add(tab);
		normalizedOrder.push(tab);
	}

	return normalizedOrder;
}

interface SidebarState {
	isSidebarOpen: boolean;
	sidebarWidth: number;
	lastOpenSidebarWidth: number;
	currentMode: SidebarMode;
	lastMode: SidebarMode;
	isResizing: boolean;
	rightSidebarTab: RightSidebarTab;
	rightSidebarTabOrder: RightSidebarTab[];
	toggleSidebar: () => void;
	setSidebarOpen: (open: boolean) => void;
	setSidebarWidth: (width: number) => void;
	setMode: (mode: SidebarMode) => void;
	setIsResizing: (isResizing: boolean) => void;
	setRightSidebarTab: (tab: RightSidebarTab) => void;
	setRightSidebarTabOrder: (order: RightSidebarTab[]) => void;
	moveRightSidebarTab: (
		activeTab: RightSidebarTab,
		overTab: RightSidebarTab,
	) => void;
}

export const useSidebarStore = create<SidebarState>()(
	devtools(
		persist(
			(set, get) => ({
				isSidebarOpen: true,
				sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
				lastOpenSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
				currentMode: SidebarMode.Tabs,
				lastMode: SidebarMode.Tabs,
				isResizing: false,
				rightSidebarTab: RightSidebarTab.Changes,
				rightSidebarTabOrder: normalizeRightSidebarTabOrder(
					DEFAULT_RIGHT_SIDEBAR_TAB_ORDER,
				),

				toggleSidebar: () => {
					const { isSidebarOpen, lastOpenSidebarWidth, currentMode, lastMode } =
						get();
					if (isSidebarOpen) {
						set({
							isSidebarOpen: false,
							sidebarWidth: 0,
							lastMode: currentMode,
							currentMode: SidebarMode.Tabs,
						});
					} else {
						set({
							isSidebarOpen: true,
							sidebarWidth: lastOpenSidebarWidth,
							currentMode: lastMode,
						});
					}
				},

				setSidebarOpen: (open) => {
					const { lastOpenSidebarWidth, currentMode, lastMode } = get();
					if (open) {
						set({
							isSidebarOpen: true,
							sidebarWidth: lastOpenSidebarWidth,
							currentMode: lastMode,
						});
					} else {
						set({
							isSidebarOpen: false,
							sidebarWidth: 0,
							lastMode: currentMode,
							currentMode: SidebarMode.Tabs,
						});
					}
				},

				setSidebarWidth: (width) => {
					const clampedWidth = Math.max(
						MIN_SIDEBAR_WIDTH,
						Math.min(MAX_SIDEBAR_WIDTH, width),
					);

					if (width > 0) {
						const { sidebarWidth, lastOpenSidebarWidth, isSidebarOpen } = get();
						if (
							sidebarWidth === clampedWidth &&
							lastOpenSidebarWidth === clampedWidth &&
							isSidebarOpen
						) {
							return;
						}
						set({
							sidebarWidth: clampedWidth,
							lastOpenSidebarWidth: clampedWidth,
							isSidebarOpen: true,
						});
					} else {
						const { currentMode } = get();
						set({
							sidebarWidth: 0,
							isSidebarOpen: false,
							lastMode: currentMode,
							currentMode: SidebarMode.Tabs,
						});
					}
				},

				setMode: (mode) => {
					set({ currentMode: mode });
				},

				setIsResizing: (isResizing) => {
					set({ isResizing });
				},

				setRightSidebarTab: (tab) => {
					set({ rightSidebarTab: tab });
				},

				setRightSidebarTabOrder: (order) => {
					set({
						rightSidebarTabOrder: normalizeRightSidebarTabOrder(order),
					});
				},

				moveRightSidebarTab: (activeTab, overTab) => {
					if (activeTab === overTab) {
						return;
					}

					const rightSidebarTabOrder = normalizeRightSidebarTabOrder(
						get().rightSidebarTabOrder,
					);
					const activeIndex = rightSidebarTabOrder.indexOf(activeTab);
					const overIndex = rightSidebarTabOrder.indexOf(overTab);

					if (activeIndex === -1 || overIndex === -1) {
						return;
					}

					const nextOrder = [...rightSidebarTabOrder];
					const [movedTab] = nextOrder.splice(activeIndex, 1);
					nextOrder.splice(overIndex, 0, movedTab);

					set({ rightSidebarTabOrder: nextOrder });
				},
			}),
			{
				name: "sidebar-store",
				migrate: (persistedState: unknown, _version: number) => {
					const state = persistedState as Partial<SidebarState>;
					// Convert old percentage-based values (<100) to pixel widths
					if (state.sidebarWidth !== undefined && state.sidebarWidth < 100) {
						state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
						state.lastOpenSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
					}
					state.rightSidebarTabOrder = normalizeRightSidebarTabOrder(
						state.rightSidebarTabOrder,
					);
					if (!isRightSidebarTab(state.rightSidebarTab)) {
						state.rightSidebarTab = RightSidebarTab.Changes;
					}
					return state as SidebarState;
				},
				version: 2,
			},
		),
		{ name: "SidebarStore" },
	),
);
