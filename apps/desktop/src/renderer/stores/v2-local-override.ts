import { hasPriorSupersetUsage } from "renderer/lib/hasPriorSupersetUsage";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

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

// FORK: dev installs default to v2 unconditionally so fresh dev clones
// land on v2 immediately.
const IS_DEV = process.env.NODE_ENV === "development";

// Fresh installs default to v2; returning v1 users default to v1 and discover
// v2 via the in-sidebar banner. Persist hydration overrides this for anyone
// with a saved override.
const initialOptInV2 = IS_DEV ? true : !hasPriorSupersetUsage();

export const useV2LocalOverrideStore = create<V2LocalOverrideState>()(
	devtools(
		persist(
			(set, get) => ({
				optInV2: initialOptInV2,
				setOptInV2: (optInV2) => set({ optInV2 }),
				toggle: () => set({ optInV2: !(get().optInV2 === true) }),
			}),
			{ name: "v2-local-override-v2" },
		),
		{ name: "V2LocalOverrideStore" },
	),
);
