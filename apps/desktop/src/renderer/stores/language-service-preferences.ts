import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type LanguageServiceProviderId =
	| "typescript"
	| "json"
	| "toml"
	| "dart";

type LanguageServicePreferencesState = {
	enabledProviders: Record<LanguageServiceProviderId, boolean>;
	hasHydrated: boolean;
	setProviderEnabled: (
		providerId: LanguageServiceProviderId,
		enabled: boolean,
	) => void;
	setHasHydrated: (hasHydrated: boolean) => void;
};

const DEFAULT_ENABLED_PROVIDERS: Record<LanguageServiceProviderId, boolean> = {
	typescript: true,
	json: true,
	toml: true,
	dart: true,
};

export const useLanguageServicePreferencesStore =
	create<LanguageServicePreferencesState>()(
		devtools(
			persist(
				(set) => ({
					enabledProviders: DEFAULT_ENABLED_PROVIDERS,
					hasHydrated: false,
					setProviderEnabled: (providerId, enabled) =>
						set((state) => ({
							enabledProviders: {
								...state.enabledProviders,
								[providerId]: enabled,
							},
						})),
					setHasHydrated: (hasHydrated) => set({ hasHydrated }),
				}),
				{
					name: "language-service-preferences",
					partialize: (state) => ({
						enabledProviders: state.enabledProviders,
					}),
					onRehydrateStorage: () => (state) => {
						state?.setHasHydrated(true);
					},
				},
			),
			{ name: "LanguageServicePreferencesStore" },
		),
	);
