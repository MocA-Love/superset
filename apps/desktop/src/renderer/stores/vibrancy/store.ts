import {
	DEFAULT_VIBRANCY_STATE,
	type VibrancyState,
} from "shared/vibrancy-types";
import { create } from "zustand";
import { electronTrpcClient } from "../../lib/trpc-client";

interface VibrancyStore extends VibrancyState {
	supported: boolean;
	hydrated: boolean;
	setState: (partial: Partial<VibrancyState>) => Promise<void>;
	hydrate: () => Promise<void>;
}

function applyToDom(state: VibrancyState): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.dataset.vibrancy = state.enabled ? "on" : "off";
	root.style.setProperty("--vibrancy-alpha", (state.opacity / 100).toFixed(3));
}

let hydratePromise: Promise<void> | null = null;
let subscriptionEstablished = false;

export const useVibrancyStore = create<VibrancyStore>()((set, get) => ({
	...DEFAULT_VIBRANCY_STATE,
	supported: false,
	hydrated: false,

	hydrate: async () => {
		// Guard against StrictMode double-invocation and concurrent callers by
		// caching the in-flight promise rather than relying on post-await state.
		if (get().hydrated) return;
		if (hydratePromise) return hydratePromise;

		hydratePromise = (async () => {
			try {
				const [current, supportInfo] = await Promise.all([
					electronTrpcClient.vibrancy.get.query(),
					electronTrpcClient.vibrancy.getSupported.query(),
				]);
				applyToDom(current);
				set({ ...current, supported: supportInfo.supported, hydrated: true });

				if (!subscriptionEstablished) {
					subscriptionEstablished = true;
					electronTrpcClient.vibrancy.onChanged.subscribe(undefined, {
						onData: (incoming) => {
							applyToDom(incoming);
							set(incoming);
						},
						onError: (err) => {
							console.error("[vibrancy] subscription error:", err);
							subscriptionEstablished = false;
						},
					});
				}
			} catch (error) {
				console.error("[vibrancy] Failed to hydrate store:", error);
				applyToDom(DEFAULT_VIBRANCY_STATE);
				// Allow retry on transient failures.
				hydratePromise = null;
			}
		})();

		return hydratePromise;
	},

	setState: async (partial) => {
		const current = get();
		const optimistic: VibrancyState = {
			enabled: partial.enabled ?? current.enabled,
			opacity: partial.opacity ?? current.opacity,
			blurLevel: partial.blurLevel ?? current.blurLevel,
		};
		applyToDom(optimistic);
		set(optimistic);
		try {
			const confirmed = await electronTrpcClient.vibrancy.set.mutate(partial);
			applyToDom(confirmed);
			set(confirmed);
		} catch (error) {
			console.error("[vibrancy] Failed to persist state:", error);
			applyToDom(current);
			set(current);
		}
	},
}));
