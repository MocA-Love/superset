import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { cn } from "@superset/ui/utils";
import { useMemo } from "react";
import { LuArrowLeft } from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";

interface BrowserAutomationListProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function BrowserAutomationList({
	workspaceId,
	open,
	onOpenChange,
}: BrowserAutomationListProps) {
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
	const { sessions, bindingsByPane } = useBrowserAutomationData({
		enabled: open,
	});
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);

	const browserPanes = useMemo(() => {
		const tabById = new Map(tabs.map((t) => [t.id, t]));
		return Object.values(panes).filter(
			(p) =>
				p.type === "webview" &&
				tabById.get(p.tabId)?.workspaceId === workspaceId,
		);
	}, [panes, tabs, workspaceId]);

	// Stale bindings (bound session no longer live) count as Unassigned.
	const liveSessionIds = new Set(sessions.map((s) => s.id));
	const connectedCount = browserPanes.filter((p) => {
		const sid = bindingsByPane[p.id];
		return sid && liveSessionIds.has(sid);
	}).length;
	const unassignedCount = browserPanes.length - connectedCount;
	const needsSetupCount = sessions.filter(
		(s) => s.mcpStatus === "missing",
	).length;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!max-w-[720px] sm:!max-w-[720px] p-0 gap-0 overflow-hidden">
				<DialogHeader className="px-5 py-4 border-b">
					<DialogTitle className="text-sm">
						Browser Automation — workspace overview
					</DialogTitle>
					<DialogDescription className="text-xs">
						Every browser pane and which LLM session is driving it.
					</DialogDescription>
				</DialogHeader>

				<div className="px-4 py-3 border-b flex items-center gap-4 text-[11px]">
					<span>
						<b className="text-base tabular-nums">{browserPanes.length}</b>{" "}
						panes
					</span>
					<span className="text-emerald-300">
						<b className="text-base tabular-nums">{connectedCount}</b> connected
					</span>
					<span className="text-muted-foreground">
						<b className="text-base tabular-nums">{unassignedCount}</b>{" "}
						unassigned
					</span>
					{needsSetupCount > 0 && (
						<span className="text-amber-400">
							<b className="text-base tabular-nums">{needsSetupCount}</b> needs
							setup
						</span>
					)}
				</div>

				<div className="max-h-[460px] overflow-y-auto">
					{browserPanes.length === 0 && (
						<div className="text-xs text-muted-foreground text-center py-8">
							No browser panes in this workspace.
						</div>
					)}
					{browserPanes.map((pane, index) => {
						const sessionId = bindingsByPane[pane.id];
						const session = sessionId
							? (sessions.find((s) => s.id === sessionId) ?? null)
							: null;
						const url = pane.browser?.currentUrl ?? pane.url ?? "about:blank";
						const isConnected = session !== null;
						return (
							<div
								key={pane.id}
								className={cn(
									"flex items-center gap-3 px-4 py-3 hover:bg-muted/20",
									index !== browserPanes.length - 1 && "border-b",
								)}
							>
								<span
									className={cn(
										"size-2 rounded-full shrink-0",
										isConnected ? "bg-emerald-400" : "bg-muted-foreground/40",
									)}
								/>
								<div className="min-w-0 flex-1">
									<div className="text-xs font-semibold truncate">
										{pane.userTitle || pane.name}
									</div>
									<div className="text-[11px] text-muted-foreground truncate">
										{url}
									</div>
								</div>
								<LuArrowLeft
									className={cn(
										"size-3 shrink-0",
										isConnected
											? "text-muted-foreground"
											: "text-muted-foreground/30",
									)}
								/>
								<div className="min-w-0 flex-1">
									{session ? (
										<>
											<div className="text-xs font-medium truncate">
												{session.displayName}
											</div>
											<div className="text-[10px] text-muted-foreground truncate">
												{session.provider} ·{" "}
												{session.mcpStatus === "ready"
													? "MCP ready"
													: "MCP missing"}
											</div>
										</>
									) : (
										<div className="text-[11px] text-muted-foreground italic truncate">
											Unassigned — pick any running LLM session
										</div>
									)}
								</div>
								<div className="flex gap-1 shrink-0">
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setActiveTab(workspaceId, pane.tabId);
											setFocusedPane(pane.tabId, pane.id);
											onOpenChange(false);
										}}
									>
										Focus
									</Button>
									<Button
										size="sm"
										variant={isConnected ? "outline" : "default"}
										onClick={() => {
											// SessionConnectModal lives inside BrowserPane and only
											// mounts for the active pane; activate the target pane
											// before opening the modal.
											setActiveTab(workspaceId, pane.tabId);
											setFocusedPane(pane.tabId, pane.id);
											openConnectModal(pane.id, sessionId);
											onOpenChange(false);
										}}
									>
										{isConnected ? "Change" : "Connect"}
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
