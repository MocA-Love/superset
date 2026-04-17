import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search";
import { AivisDictionary } from "./components/AivisDictionary";
import { AivisSettings } from "./components/AivisSettings";
import { AivisUsage } from "./components/AivisUsage";
import { RingtonesSettings } from "./components/RingtonesSettings";

export const Route = createFileRoute("/_authenticated/settings/ringtones/")({
	component: RingtonesSettingsPage,
});

function RingtonesSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "ringtones").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return (
		<>
			<RingtonesSettings visibleItems={visibleItems} />
			<div className="p-6 max-w-4xl w-full pt-0">
				<AivisSettings visibleItems={visibleItems} />
				<AivisDictionary visibleItems={visibleItems} />
				<AivisUsage visibleItems={visibleItems} />
			</div>
		</>
	);
}
