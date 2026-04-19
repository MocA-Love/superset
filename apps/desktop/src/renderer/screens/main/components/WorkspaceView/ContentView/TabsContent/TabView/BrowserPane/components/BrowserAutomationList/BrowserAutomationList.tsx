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
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";

interface BrowserAutomationListProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function BrowserAutomationList({
	open,
	onOpenChange,
}: BrowserAutomationListProps) {
	const panes = useTabsStore((s) => s.panes);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const bindings = useBrowserAutomationStore((s) => s.bindings);
	const sessions = useBrowserAutomationStore((s) => s.sessions);
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);

	const browserPanes = useMemo(
		() => Object.values(panes).filter((p) => p.type === "webview"),
		[panes],
	);

	const connectedCount = browserPanes.filter((p) => bindings[p.id]).length;
	const needsSetupCount = Object.values(sessions).filter(
		(s) => s.mcpStatus === "missing",
	).length;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!max-w-[640px] sm:!max-w-[640px] p-0 gap-0 overflow-hidden">
				<DialogHeader className="px-5 py-4 border-b">
					<DialogTitle className="text-sm">Browser Automation</DialogTitle>
					<DialogDescription className="text-xs">
						All browser panes in this workspace and their bound sessions.
					</DialogDescription>
				</DialogHeader>

				<div className="p-4 grid grid-cols-3 gap-2 border-b">
					<Metric label="Browser panes" value={browserPanes.length} />
					<Metric label="Connected" value={connectedCount} />
					<Metric label="Needs setup" value={needsSetupCount} />
				</div>

				<div className="max-h-[420px] overflow-y-auto p-3 flex flex-col gap-2">
					{browserPanes.length === 0 && (
						<div className="text-xs text-muted-foreground text-center py-8">
							No browser panes in this workspace.
						</div>
					)}
					{browserPanes.map((pane) => {
						const sessionId = bindings[pane.id];
						const session = sessionId ? sessions[sessionId] : null;
						const url = pane.browser?.currentUrl ?? pane.url ?? "about:blank";
						return (
							<div
								key={pane.id}
								className={cn(
									"rounded-xl border p-3 bg-card/60",
									session && "border-brand/30 bg-brand/5",
								)}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="text-xs font-semibold truncate">
											{pane.userTitle || pane.name}
										</div>
										<div className="text-[11px] text-muted-foreground truncate">
											{url}
										</div>
									</div>
									<span
										className={cn(
											"shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
											session
												? "bg-emerald-500/15 text-emerald-300"
												: "bg-muted text-muted-foreground",
										)}
									>
										{session ? "Connected" : "Unassigned"}
									</span>
								</div>
								<div className="mt-2 text-[11px] text-muted-foreground">
									{session
										? `${session.displayName} · ${session.provider} · ${session.mcpStatus === "ready" ? "MCP ready" : "MCP missing"}`
										: "Pick any running Claude or Codex session"}
								</div>
								<div className="mt-3 flex gap-2">
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setFocusedPane(pane.tabId, pane.id);
											onOpenChange(false);
										}}
									>
										Focus
									</Button>
									<Button
										size="sm"
										onClick={() => {
											openConnectModal(pane.id);
											onOpenChange(false);
										}}
									>
										{session ? "Change" : "Connect"}
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

function Metric({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-lg bg-muted/40 p-3">
			<div className="text-xl font-bold tabular-nums">{value}</div>
			<div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
		</div>
	);
}
