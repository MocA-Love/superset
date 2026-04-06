import { Button } from "@superset/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { LuBot, LuPanelRight, LuSparkles, LuSquareArrowOutUpRight } from "react-icons/lu";
import {
	RightSidebarTab,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useTabsStore } from "renderer/stores/tabs/store";

interface ExtensionDef {
	tab: RightSidebarTab;
	icon: React.ComponentType<{ className?: string }>;
	label: string;
	viewType: string;
	extensionId: string;
}

function ExtensionButton({ tab, icon: Icon, label, viewType, extensionId }: ExtensionDef) {
	const rightSidebarTab = useSidebarStore((s) => s.rightSidebarTab);
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const setRightSidebarTab = useSidebarStore((s) => s.setRightSidebarTab);
	const setSidebarOpen = useSidebarStore((s) => s.setSidebarOpen);
	const workspaceId = useWorkspaceId();
	const addTab = useTabsStore((s) => s.addTab);
	const panes = useTabsStore((s) => s.panes);

	const isActive = isSidebarOpen && rightSidebarTab === tab;

	const handleClick = () => {
		if (isActive) {
			setSidebarOpen(false);
		} else {
			setRightSidebarTab(tab);
			if (!isSidebarOpen) {
				setSidebarOpen(true);
			}
		}
	};

	const handleOpenAsTab = () => {
		if (!workspaceId) return;
		const { tabId, paneId } = addTab(workspaceId);
		// Mutate the pane to be a vscode-extension pane
		const pane = panes[paneId];
		if (pane) {
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[paneId]: {
						...state.panes[paneId],
						type: "vscode-extension" as const,
						name: label,
						vscodeExtension: { viewType, extensionId },
					},
				},
			}));
		}
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleClick}
								aria-label={label}
								aria-pressed={isActive}
								className={cn(
									"no-drag gap-1.5 h-6 px-1.5 rounded",
									isActive
										? "font-semibold text-foreground bg-accent"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Icon className="size-3" />
								<span className="text-xs">{label}</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							{isActive ? `Hide ${label}` : `Open ${label} in sidebar`}
						</TooltipContent>
					</Tooltip>
				</span>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={handleClick}>
					<LuPanelRight className="size-4 mr-2" />
					{isActive ? "Hide sidebar" : "Open in sidebar"}
				</ContextMenuItem>
				<ContextMenuItem onClick={handleOpenAsTab}>
					<LuSquareArrowOutUpRight className="size-4 mr-2" />
					Open as tab
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function VscodeExtensionButtons() {
	return (
		<div className="flex items-center gap-1">
			<ExtensionButton
				tab={RightSidebarTab.ClaudeCode}
				icon={LuBot}
				label="Claude"
				viewType="claudeVSCodeSidebar"
				extensionId="anthropic.claude-code"
			/>
			<ExtensionButton
				tab={RightSidebarTab.Codex}
				icon={LuSparkles}
				label="Codex"
				viewType="chatgpt.sidebarView"
				extensionId="openai.chatgpt"
			/>
		</div>
	);
}
