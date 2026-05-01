import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

const IS_DEV = process.env.NODE_ENV === "development";

interface V2LocalOverrideState {
	/**
	 * When `true`, the user has opted into v2. v2 is gated behind both the
	 * remote flag and this opt-in. `null` means the resolver hasn't yet run
	 * on this install (fresh launch).
	 *
	 * FORK NOTE: dev installs default to `true` (upstream #3927) so fresh
	 * dev clones land on v2 immediately. Prod retains the fork's `null`
	 * default so users explicitly opt-in via the Experimental settings.
	 */
	optInV2: boolean | null;
	setOptInV2: (optInV2: boolean) => void;
	/** FORK: convenience toggle used by the experimental settings UI. */
	toggle: () => void;
}

export const useV2LocalOverrideStore = create<V2LocalOverrideState>()(
	devtools(
		persist(
			(set, get) => ({
				optInV2: IS_DEV ? true : null,
				setOptInV2: (optInV2) => set({ optInV2 }),
				toggle: () => set({ optInV2: !(get().optInV2 === true) }),
			}),
			{ name: "v2-local-override-v2" },
		),
		{ name: "V2LocalOverrideStore" },
	),
);
