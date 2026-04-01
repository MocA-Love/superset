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
					const providerId = provider.providerId;
					const isKnownProvider = isKnownProviderId(providerId);
					const checked = isKnownProvider
						? enabledProviders[providerId]
						: provider.enabled;
					const isSwitchDisabled =
						isLoading || setProviderEnabled.isPending || !isKnownProvider;

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
								{!isKnownProvider ? (
									<p className="text-xs text-muted-foreground">
										この provider は現在の設定 UI からは変更できません。
									</p>
								) : null}
							</div>
							<Switch
								id={`language-service-${provider.providerId}`}
								checked={checked}
								disabled={isSwitchDisabled}
								onCheckedChange={async (nextChecked) => {
									if (!isKnownProvider) {
										return;
									}

									const previous = enabledProviders[providerId];
									try {
										await setProviderEnabled.mutateAsync({
											providerId,
											enabled: nextChecked,
										});
										setProviderEnabledPreference(providerId, nextChecked);
										await utils.languageServices.getWorkspaceDiagnostics.invalidate();
									} catch (error) {
										setProviderEnabledPreference(providerId, previous);
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
