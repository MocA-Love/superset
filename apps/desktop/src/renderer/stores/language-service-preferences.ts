import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type LanguageServiceProviderId =
	| "typescript"
	| "json"
	| "yaml"
	| "html"
	| "css"
	| "toml"
	| "dart"
	| "python"
	| "go"
	| "rust"
	| "dockerfile"
	| "graphql";

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
	yaml: true,
	html: true,
	css: true,
	toml: true,
	dart: true,
	python: true,
	go: true,
	rust: true,
	dockerfile: true,
	graphql: true,
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
					merge: (persistedState, currentState) => {
						const persistedEnabledProviders =
							(
								persistedState as
									| {
											enabledProviders?: Partial<
												Record<LanguageServiceProviderId, boolean>
											>;
									  }
									| undefined
							)?.enabledProviders ?? {};
						return {
							...currentState,
							...(persistedState as object),
							enabledProviders: {
								...DEFAULT_ENABLED_PROVIDERS,
								...persistedEnabledProviders,
							},
						};
					},
					onRehydrateStorage: () => (state) => {
						state?.setHasHydrated(true);
					},
				},
			),
			{ name: "LanguageServicePreferencesStore" },
		),
	);
