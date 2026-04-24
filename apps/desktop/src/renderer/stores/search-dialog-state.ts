import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type SearchDialogMode = "quickOpen" | "keywordSearch";
export type SearchScope = "workspace" | "global";
export type SearchResultViewMode = "tree" | "list";

interface SearchDialogModeState {
	includePattern: string;
	excludePattern: string;
	filtersOpen: boolean;
	scope?: SearchScope;
}

interface SearchDialogState {
	byMode: Record<SearchDialogMode, SearchDialogModeState>;
	resultViewMode: SearchResultViewMode;
	setIncludePattern: (mode: SearchDialogMode, value: string) => void;
	setExcludePattern: (mode: SearchDialogMode, value: string) => void;
	setFiltersOpen: (mode: SearchDialogMode, open: boolean) => void;
	setScope: (mode: SearchDialogMode, scope: SearchScope) => void;
	setResultViewMode: (mode: SearchResultViewMode) => void;
}

const DEFAULT_MODE_STATE: SearchDialogModeState = {
	includePattern: "",
	excludePattern: "",
	filtersOpen: false,
};

export const useSearchDialogStore = create<SearchDialogState>()(
	devtools(
		persist(
			(set) => ({
				byMode: {
					quickOpen: { ...DEFAULT_MODE_STATE },
					keywordSearch: { ...DEFAULT_MODE_STATE },
				},
				resultViewMode: "tree",

				setIncludePattern: (mode, value) => {
					set((state) => ({
						byMode: {
							...state.byMode,
							[mode]: {
								...state.byMode[mode],
								includePattern: value,
							},
						},
					}));
				},

				setExcludePattern: (mode, value) => {
					set((state) => ({
						byMode: {
							...state.byMode,
							[mode]: {
								...state.byMode[mode],
								excludePattern: value,
							},
						},
					}));
				},

				setFiltersOpen: (mode, open) => {
					set((state) => ({
						byMode: {
							...state.byMode,
							[mode]: {
								...state.byMode[mode],
								filtersOpen: open,
							},
						},
					}));
				},

				setScope: (mode, scope) => {
					set((state) => ({
						byMode: {
							...state.byMode,
							[mode]: {
								...state.byMode[mode],
								scope,
							},
						},
					}));
				},

				setResultViewMode: (mode) => {
					set({ resultViewMode: mode });
				},
			}),
			{
				name: "search-dialog-store",
				version: 2,
				migrate: (persisted, version) => {
					const state = persisted as Record<string, unknown>;
					if (version === 0) {
						const byMode = state.byMode as
							| Record<string, Record<string, unknown>>
							| undefined;
						if (byMode) {
							for (const mode of Object.values(byMode)) {
								if (mode.scope === undefined) {
									mode.scope = "workspace";
								}
							}
						}
					}
					if (version < 2 && state.resultViewMode === undefined) {
						state.resultViewMode = "tree";
					}
					return state as unknown as SearchDialogState;
				},
			},
		),
		{ name: "SearchDialogStore" },
	),
);
