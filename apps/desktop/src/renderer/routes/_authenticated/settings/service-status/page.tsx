import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search";
import { ServiceStatusSettings } from "./components/ServiceStatusSettings";

export const Route = createFileRoute(
	"/_authenticated/settings/service-status/",
)({
	component: ServiceStatusSettingsPage,
});

function ServiceStatusSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "serviceStatus").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <ServiceStatusSettings visibleItems={visibleItems} />;
}
