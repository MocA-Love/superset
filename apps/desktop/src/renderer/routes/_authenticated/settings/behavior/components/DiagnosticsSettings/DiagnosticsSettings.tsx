import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type LanguageServiceProviderId,
	useLanguageServicePreferencesStore,
} from "renderer/stores/language-service-preferences";

interface DiagnosticsSettingsProps {
	visible: boolean;
}

function isKnownProviderId(
	providerId: string,
): providerId is LanguageServiceProviderId {
	return ["typescript", "json", "toml", "dart"].includes(providerId);
}

export function DiagnosticsSettings({ visible }: DiagnosticsSettingsProps) {
	const utils = electronTrpc.useUtils();
	const enabledProviders = useLanguageServicePreferencesStore(
		(state) => state.enabledProviders,
	);
	const setProviderEnabledPreference = useLanguageServicePreferencesStore(
		(state) => state.setProviderEnabled,
	);
	const { data: providers = [], isLoading } =
		electronTrpc.languageServices.getProviders.useQuery();

	const setProviderEnabled =
		electronTrpc.languageServices.setProviderEnabled.useMutation({
			onSuccess: async () => {
				await utils.languageServices.getProviders.invalidate();
			},
		});

	if (!visible) {
		return null;
	}

	return (
		<div className="space-y-4">
			<div className="space-y-0.5">
				<Label className="text-sm font-medium">Language diagnostics</Label>
				<p className="text-xs text-muted-foreground">
					Problems とエディタ下線に使う言語サービスを切り替えます。TSX と JSX は
					TypeScript provider に含まれます。
				</p>
			</div>

			<div className="space-y-3">
				{providers.map((provider) => {
					const isKnownProvider = isKnownProviderId(provider.providerId);
					const checked = isKnownProvider
						? enabledProviders[provider.providerId]
						: provider.enabled;

					return (
						<div
							key={provider.providerId}
							className="flex items-center justify-between gap-4"
						>
							<div className="space-y-0.5">
								<Label
									htmlFor={`language-service-${provider.providerId}`}
									className="text-sm font-medium"
								>
									{provider.label}
								</Label>
								<p className="text-xs text-muted-foreground">
									{provider.description}
								</p>
							</div>
							<Switch
								id={`language-service-${provider.providerId}`}
								checked={checked}
								disabled={isLoading || setProviderEnabled.isPending}
								onCheckedChange={async (nextChecked) => {
									if (!isKnownProvider) {
										return;
									}

									const previous = enabledProviders[provider.providerId];
									try {
										await setProviderEnabled.mutateAsync({
											providerId: provider.providerId,
											enabled: nextChecked,
										});
										setProviderEnabledPreference(
											provider.providerId,
											nextChecked,
										);
										await utils.languageServices.getWorkspaceDiagnostics.invalidate();
									} catch (error) {
										setProviderEnabledPreference(provider.providerId, previous);
										toast.error(
											error instanceof Error
												? error.message
												: "Failed to update language diagnostics setting",
										);
									}
								}}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}
