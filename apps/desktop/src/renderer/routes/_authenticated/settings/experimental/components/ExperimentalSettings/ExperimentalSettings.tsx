import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { useNavigate } from "@tanstack/react-router";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { track } from "renderer/lib/analytics";
import { useOnboardingStore } from "renderer/stores/onboarding";
import { useV2LocalOverrideStore } from "renderer/stores/v2-local-override";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface ExperimentalSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

// FORK NOTE: v1 -> v2 migration UI was removed in the fork because the
// underlying trpc procedures (readV1WorkspaceSections / listState /
// upsertState) are not part of the fork's trpc surface. cycle 38 keeps the
// SETTING_ITEM_ID.EXPERIMENTAL_V1_MIGRATION constant for settings search
// keyword stability, but the "Run again" button + last-run badge are not
// rendered. Restore (and re-wire the missing trpc procedures) when v1->v2
// migration is intentionally re-introduced.
export function ExperimentalSettings({
	visibleItems,
}: ExperimentalSettingsProps) {
	const showSupersetV2 = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_SUPERSET_V2,
		visibleItems,
	);
	const showRerunOnboarding = isItemVisible(
		SETTING_ITEM_ID.EXPERIMENTAL_RERUN_ONBOARDING,
		visibleItems,
	);
	const isV2CloudEnabled = useIsV2CloudEnabled();
	const setOptInV2 = useV2LocalOverrideStore((state) => state.setOptInV2);
	const resetOnboarding = useOnboardingStore((state) => state.reset);
	const navigate = useNavigate();

	const handleRerunOnboarding = () => {
		track("onboarding_rerun_opened");
		resetOnboarding();
		void navigate({ to: "/setup/providers" });
	};

	return (
		<div className="p-6 max-w-4xl w-full mx-auto">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Experimental</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Try early access features and previews.
				</p>
			</div>

			<div className="space-y-6">
				{showSupersetV2 && (
					<div className="flex items-center justify-between gap-6">
						<div className="min-w-0 flex-1 space-y-0.5">
							<Label htmlFor="superset-v2" className="text-sm font-medium">
								Try Superset v2
							</Label>
							<p className="text-xs text-muted-foreground">
								Use the new workspace experience.
							</p>
						</div>
						<Switch
							id="superset-v2"
							checked={isV2CloudEnabled}
							onCheckedChange={(enabled) => {
								track("surface_toggled", {
									from: isV2CloudEnabled ? "v2" : "v1",
									to: enabled ? "v2" : "v1",
								});
								setOptInV2(enabled);
							}}
						/>
					</div>
				)}

				{showRerunOnboarding && (
					<div className="flex items-center justify-between gap-6">
						<div className="min-w-0 flex-1 space-y-0.5">
							<Label className="text-sm font-medium">Run setup again</Label>
							<p className="text-xs text-muted-foreground">
								Reopen the setup guide to connect agents, the GitHub CLI, and
								add a project. You can skip any step.
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleRerunOnboarding}
							className="shrink-0"
						>
							Open setup
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
