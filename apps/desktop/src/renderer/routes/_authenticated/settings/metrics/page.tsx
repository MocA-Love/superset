import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search/settings-search";
import { MetricsSettings } from "./components/MetricsSettings";

export const Route = createFileRoute("/_authenticated/settings/metrics/")({
	component: MetricsSettingsPage,
});

function MetricsSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "metrics").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <MetricsSettings visibleItems={visibleItems} />;
}
