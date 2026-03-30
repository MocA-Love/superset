import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TerminalSuggestionsState {
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}

export const useTerminalSuggestionsStore = create<TerminalSuggestionsState>()(
	persist(
		(set) => ({
			enabled: true,
			setEnabled: (enabled) => set({ enabled }),
		}),
		{ name: "terminal-suggestions" },
	),
);
