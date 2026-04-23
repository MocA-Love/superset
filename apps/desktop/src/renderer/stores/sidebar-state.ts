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
	ClaudeCode = "claude-code",
	Codex = "codex",
	Kimi = "kimi",
}

export const DEFAULT_RIGHT_SIDEBAR_TAB_ORDER = [
	RightSidebarTab.Changes,
	RightSidebarTab.Docker,
	RightSidebarTab.Files,
	RightSidebarTab.Search,
	RightSidebarTab.Problems,
	RightSidebarTab.Databases,
	RightSidebarTab.ClaudeCode,
	RightSidebarTab.Codex,
	RightSidebarTab.Kimi,
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

function sanitizeSidebarState(
	state: Partial<SidebarState> | undefined,
): Partial<SidebarState> {
	if (!state) {
		return {};
	}

	const sidebarWidth =
		typeof state.sidebarWidth === "number" && state.sidebarWidth > 0
			? Math.max(
					MIN_SIDEBAR_WIDTH,
					Math.min(MAX_SIDEBAR_WIDTH, state.sidebarWidth),
				)
			: state.sidebarWidth === 0
				? 0
				: DEFAULT_SIDEBAR_WIDTH;
	const lastOpenSidebarWidth =
		typeof state.lastOpenSidebarWidth === "number" &&
		state.lastOpenSidebarWidth > 0
			? Math.max(
					MIN_SIDEBAR_WIDTH,
					Math.min(MAX_SIDEBAR_WIDTH, state.lastOpenSidebarWidth),
				)
			: sidebarWidth > 0
				? sidebarWidth
				: DEFAULT_SIDEBAR_WIDTH;

	// Migrate legacy rightSidebarTab (single value) to per-workspace map
	const rawMap = state.rightSidebarTabByWorkspace ?? {};
	const sanitizedMap: Record<string, RightSidebarTab> = {};
	for (const [workspaceId, tab] of Object.entries(rawMap)) {
		if (isRightSidebarTab(tab)) {
			sanitizedMap[workspaceId] = tab;
		}
	}

	return {
		...state,
		sidebarWidth,
		lastOpenSidebarWidth,
		isResizing: false,
		rightSidebarTabByWorkspace: sanitizedMap,
		rightSidebarTabOrder: normalizeRightSidebarTabOrder(
			state.rightSidebarTabOrder,
		),
	};
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
	rightSidebarTabByWorkspace: Record<string, RightSidebarTab>;
	rightSidebarTabOrder: RightSidebarTab[];
	toggleSidebar: () => void;
	setSidebarOpen: (open: boolean) => void;
	setSidebarWidth: (width: number) => void;
	setMode: (mode: SidebarMode) => void;
	setIsResizing: (isResizing: boolean) => void;
	setRightSidebarTab: (workspaceId: string, tab: RightSidebarTab) => void;
	getRightSidebarTab: (workspaceId: string) => RightSidebarTab;
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
				rightSidebarTabByWorkspace: {},
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

				setRightSidebarTab: (workspaceId, tab) => {
					set((state) => ({
						rightSidebarTabByWorkspace: {
							...state.rightSidebarTabByWorkspace,
							[workspaceId]: tab,
						},
					}));
				},

				getRightSidebarTab: (workspaceId) => {
					return (
						get().rightSidebarTabByWorkspace[workspaceId] ??
						RightSidebarTab.Changes
					);
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
					const state = persistedState as Partial<SidebarState> & {
						rightSidebarTab?: RightSidebarTab;
					};
					// Convert legacy percentage-based widths before general sanitization.
					if (state.sidebarWidth !== undefined && state.sidebarWidth < 100) {
						state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
						state.lastOpenSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
					}
					// v2 -> v3: migrate single rightSidebarTab to per-workspace map
					if (state.rightSidebarTab !== undefined) {
						delete state.rightSidebarTab;
					}
					return sanitizeSidebarState(state) as SidebarState;
				},
				merge: (persistedState, currentState) => ({
					...currentState,
					...sanitizeSidebarState(
						(
							persistedState as
								| (Partial<SidebarState> & { state?: Partial<SidebarState> })
								| undefined
						)?.state ?? (persistedState as Partial<SidebarState> | undefined),
					),
				}),
				version: 3,
			},
		),
		{ name: "SidebarStore" },
	),
);
