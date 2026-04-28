import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

interface V2LocalOverrideState {
	/** When true, the user has opted into v2. v2 is gated behind both the remote flag and this opt-in. */
	optInV2: boolean;
	toggle: () => void;
}

export const useV2LocalOverrideStore = create<V2LocalOverrideState>()(
	devtools(
		persist(
			(set, get) => ({
				optInV2: false,
				toggle: () => set({ optInV2: !get().optInV2 }),
			}),
			{ name: "v2-local-override-v2" },
		),
		{ name: "V2LocalOverrideStore" },
	),
);
