import type { ExternalApp } from "@superset/local-db";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useSidebarStore } from "renderer/stores/sidebar-state";
import { SidebarControl } from "../../SidebarControl";
import { ContentHeader } from "./ContentHeader";
import { PresetsBar } from "./components/PresetsBar";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";

interface ContentViewProps {
	workspaceId: string;
	defaultExternalApp?: ExternalApp | null;
	onOpenInApp: () => void;
	onOpenQuickOpen: () => void;
}

export function ContentView({
	workspaceId,
	defaultExternalApp,
	onOpenInApp,
	onOpenQuickOpen,
}: ContentViewProps) {
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const { data: showPresetsBar } =
		electronTrpc.settings.getShowPresetsBar.useQuery();

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<ContentHeader
				trailingAction={!isSidebarOpen ? <SidebarControl /> : undefined}
			>
				<GroupStrip />
			</ContentHeader>
			{showPresetsBar && <PresetsBar />}
			<TabsContent
				workspaceId={workspaceId}
				defaultExternalApp={defaultExternalApp}
				onOpenInApp={onOpenInApp}
				onOpenQuickOpen={onOpenQuickOpen}
			/>
		</div>
	);
}
