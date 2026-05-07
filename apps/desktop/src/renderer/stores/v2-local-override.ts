import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

interface V2LocalOverrideState {
	/**
	 * When `true`, the user has opted into v2. v2 is gated behind both the
	 * remote flag and this opt-in. `null` means the resolver hasn't yet run
	 * on this install (fresh launch).
	 */
	optInV2: boolean | null;
	isFreshInstall: boolean | null;
	setOptInV2: (optInV2: boolean) => void;
	setIsFreshInstall: (isFreshInstall: boolean) => void;
	/** FORK: convenience toggle used by the experimental settings UI. */
	toggle: () => void;
}

export const useV2LocalOverrideStore = create<V2LocalOverrideState>()(
	devtools(
		persist(
			(set, get) => ({
				optInV2: null,
				isFreshInstall: null,
				setOptInV2: (optInV2) => set({ optInV2 }),
				setIsFreshInstall: (isFreshInstall) => set({ isFreshInstall }),
				toggle: () => set({ optInV2: !(get().optInV2 === true) }),
			}),
			{ name: "v2-local-override-v2" },
		),
		{ name: "V2LocalOverrideStore" },
	),
);
