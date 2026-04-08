import type { ExternalApp } from "@superset/local-db";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserFullscreenStore } from "renderer/stores/browser-fullscreen";
import { useSidebarStore } from "renderer/stores/sidebar-state";
import { SidebarControl } from "../../SidebarControl";
import { VscodeExtensionButtons } from "../../VscodeExtensionButtons";
import { ContentHeader } from "./ContentHeader";
import { PresetsBar } from "./components/PresetsBar";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";

interface ContentViewProps {
	workspaceId: string;
	isActive?: boolean;
	defaultExternalApp?: ExternalApp | null;
	onOpenInApp: () => void;
	onOpenQuickOpen: () => void;
}

export function ContentView({
	workspaceId,
	isActive = true,
	defaultExternalApp,
	onOpenInApp,
	onOpenQuickOpen,
}: ContentViewProps) {
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const isBrowserFullscreen = useBrowserFullscreenStore(
		(s) => s.fullscreenPaneId !== null,
	);
	const { data: showPresetsBar } =
		electronTrpc.settings.getShowPresetsBar.useQuery();

	return (
		<div className="h-full flex flex-col overflow-hidden">
			{!isBrowserFullscreen && (
				<ContentHeader
					trailingAction={
						<div className="flex items-center gap-1">
							<VscodeExtensionButtons />
							{!isSidebarOpen && !isTearoffWindow() && <SidebarControl />}
						</div>
					}
				>
					<GroupStrip />
				</ContentHeader>
			)}
			{showPresetsBar && !isBrowserFullscreen && <PresetsBar />}
			<TabsContent
				workspaceId={workspaceId}
				isActive={isActive}
				defaultExternalApp={defaultExternalApp}
				onOpenInApp={onOpenInApp}
				onOpenQuickOpen={onOpenQuickOpen}
			/>
		</div>
	);
}
