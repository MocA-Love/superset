import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { DiagnosticsSettings } from "../behavior/components/DiagnosticsSettings";
import {
	getMatchingItemsForSection,
	SETTING_ITEM_ID,
} from "../utils/settings-search";

export const Route = createFileRoute("/_authenticated/settings/diagnostics/")({
	component: DiagnosticsSettingsPage,
});

function DiagnosticsSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "diagnostics").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	const showDiagnostics = visibleItems
		? visibleItems.includes(SETTING_ITEM_ID.BEHAVIOR_LANGUAGE_DIAGNOSTICS)
		: true;

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Diagnostics</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Configure which language services report errors and warnings in
					Problems and the editor.
				</p>
			</div>

			<DiagnosticsSettings visible={showDiagnostics} />
		</div>
	);
}
