import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useEffect, useMemo } from "react";
import { LuCopy, LuList } from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AutomationSession,
	getSnippetForSession,
	useBrowserAutomationStore,
} from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";

interface SessionConnectModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SessionConnectModal({
	open,
	onOpenChange,
}: SessionConnectModalProps) {
	const paneId = useBrowserAutomationStore((s) => s.connectModal.paneId);
	const selectedSessionId = useBrowserAutomationStore(
		(s) => s.connectModal.selectedSessionId,
	);
	const setSelectedSession = useBrowserAutomationStore(
		(s) => s.setSelectedSession,
	);
	const setListViewOpen = useBrowserAutomationStore((s) => s.setListViewOpen);

	const { sessions, bindingsByPane, mcpStatus } = useBrowserAutomationData({
		enabled: open,
	});

	const setBinding = electronTrpc.browserAutomation.setBinding.useMutation();
	const removeBinding =
		electronTrpc.browserAutomation.removeBinding.useMutation();
	const utils = electronTrpc.useUtils();

	const pane = useTabsStore((s) => (paneId ? s.panes[paneId] : null));
	const panes = useTabsStore((s) => s.panes);

	const session = selectedSessionId
		? (sessions.find((s) => s.id === selectedSessionId) ?? null)
		: null;
	const currentBinding = paneId ? bindingsByPane[paneId] : null;
	const currentSession = currentBinding
		? (sessions.find((s) => s.id === currentBinding) ?? null)
		: null;

	// Auto-select a sensible default when the modal opens with nothing picked,
	// and reset the selection when the chosen session drops out of the live
	// set (e.g. it transitioned to `done` / `aborted`).
	useEffect(() => {
		if (!open || !paneId) return;
		const selectedStillLive =
			selectedSessionId && sessions.some((s) => s.id === selectedSessionId);
		if (selectedStillLive) return;
		// Only fall back to the currently-bound session if it is still in the
		// live set — otherwise the modal would open with a truthy selection
		// whose detail view can't render and whose Connect button stays
		// blocked.
		const bindingIsLive =
			currentBinding && sessions.some((s) => s.id === currentBinding);
		const fallback =
			(bindingIsLive ? currentBinding : null) ?? sessions[0]?.id ?? null;
		// Avoid a re-render loop while queries are still resolving: if the
		// computed fallback is already what we have selected, don't touch
		// the store. Otherwise a changing `sessions` identity on each load
		// pass would keep rewriting `null → null`.
		if (fallback === selectedSessionId) return;
		setSelectedSession(fallback);
	}, [
		open,
		paneId,
		selectedSessionId,
		currentBinding,
		sessions,
		setSelectedSession,
	]);

	const assignedPaneIdForSelected = useMemo(() => {
		if (!selectedSessionId) return null;
		const entry = Object.entries(bindingsByPane).find(
			([pid, sid]) => sid === selectedSessionId && pid !== paneId,
		);
		return entry?.[0] ?? null;
	}, [bindingsByPane, paneId, selectedSessionId]);

	const paneUrl = pane?.browser?.currentUrl ?? pane?.url ?? "about:blank";
	const paneName = pane?.userTitle || pane?.name || "Browser pane";

	const handleConnect = async () => {
		if (!paneId || !session || session.mcpStatus !== "ready") return;
		try {
			const result = await setBinding.mutateAsync({
				paneId,
				sessionId: session.id,
				sessionKind: session.id.startsWith("terminal:")
					? "terminal"
					: "todo-agent",
			});
			await utils.browserAutomation.listBindings.invalidate();
			if (result.previousPaneId) {
				const fromPane = panes[result.previousPaneId];
				toast.success(
					`${session.displayName} moved from ${fromPane?.name ?? "another pane"} to ${paneName}`,
				);
			} else {
				toast.success(
					`${paneName} is now controlled by ${session.displayName}`,
				);
			}
			onOpenChange(false);
		} catch (error) {
			toast.error(
				`Failed to connect session: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleDisconnect = async () => {
		if (!paneId || !currentBinding) return;
		try {
			await removeBinding.mutateAsync({ paneId });
			await utils.browserAutomation.listBindings.invalidate();
			const label = currentSession?.displayName ?? "Previous session";
			toast.info(`${label} disconnected from ${paneName}`);
		} catch (error) {
			toast.error(
				`Failed to disconnect: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleCopySnippet = async () => {
		if (!session) return;
		try {
			await navigator.clipboard.writeText(getSnippetForSession(session));
			toast.success("Configuration snippet copied");
		} catch {
			toast.error("Failed to copy snippet");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!max-w-[820px] sm:!max-w-[820px] p-0 gap-0 overflow-hidden">
				<DialogHeader className="px-5 py-4 border-b">
					<DialogTitle className="text-sm">
						Connect browser automation
					</DialogTitle>
					<DialogDescription className="text-xs">
						Choose which running LLM session should control this browser pane.
					</DialogDescription>
				</DialogHeader>

				<div className="grid grid-cols-[minmax(320px,1fr)_minmax(280px,0.9fr)] min-h-[380px] max-h-[560px]">
					<div className="overflow-y-auto p-4 border-r">
						<div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5 mb-3">
							<div className="flex size-7 items-center justify-center rounded-md bg-brand/15 text-brand text-sm font-bold">
								◎
							</div>
							<div className="min-w-0">
								<div className="text-xs font-semibold truncate">{paneName}</div>
								<div className="text-[11px] text-muted-foreground truncate">
									{paneUrl}
								</div>
							</div>
							<button
								type="button"
								onClick={() => {
									// Close this dialog first so focus traps don't stack.
									onOpenChange(false);
									setListViewOpen(true);
								}}
								className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
							>
								<LuList className="size-3" />
								All panes
							</button>
						</div>

						<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1 mb-2">
							Running sessions
						</div>

						{sessions.length === 0 ? (
							<div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
								No running LLM sessions found. Start a TODO-Agent session or run
								`claude` / `codex` in any terminal pane, then return here.
							</div>
						) : (
							<div className="flex flex-col gap-2">
								{sessions.map((s) => {
									const otherPaneId = Object.entries(bindingsByPane).find(
										([pid, sid]) => sid === s.id && pid !== paneId,
									)?.[0];
									const otherPaneName = otherPaneId
										? (panes[otherPaneId]?.name ?? null)
										: null;
									return (
										<SessionCard
											key={s.id}
											session={s}
											isSelected={s.id === selectedSessionId}
											assignedElsewherePaneName={otherPaneName}
											onSelect={() => setSelectedSession(s.id)}
										/>
									);
								})}
							</div>
						)}
					</div>

					<div className="overflow-y-auto p-4 bg-muted/20">
						{session ? (
							session.mcpStatus === "ready" ? (
								<ReadyPanel
									session={session}
									paneName={paneName}
									reassigning={Boolean(assignedPaneIdForSelected)}
									previousPaneName={
										assignedPaneIdForSelected
											? (panes[assignedPaneIdForSelected]?.name ?? null)
											: null
									}
								/>
							) : (
								<SetupPanel
									session={session}
									mcpConfigPath={
										session.provider === "Codex"
											? (mcpStatus?.codexConfigPath ?? null)
											: (mcpStatus?.claudeConfigPath ?? null)
									}
									onCopy={handleCopySnippet}
								/>
							)
						) : (
							<div className="text-xs text-muted-foreground">
								Select a session to see details.
							</div>
						)}
					</div>
				</div>

				<DialogFooter className="px-5 py-3 border-t gap-2 flex !justify-between">
					<div className="text-[11px] text-muted-foreground">
						{session?.mcpStatus === "ready"
							? assignedPaneIdForSelected
								? `Connecting will reassign ${session.displayName} from ${panes[assignedPaneIdForSelected]?.name ?? "another pane"} to ${paneName}.`
								: "Connecting binds this browser pane to the selected session only."
							: session
								? "Add the MCP entry first, then reopen or restart this session."
								: sessions.length === 0
									? "Start an LLM session, then pick it here."
									: "Select a session from the left."}
					</div>
					<div className="flex items-center gap-2">
						{currentBinding && (
							<Button
								variant="outline"
								size="sm"
								onClick={handleDisconnect}
								disabled={removeBinding.isPending}
							>
								Disconnect
								{currentSession ? ` ${currentSession.displayName}` : ""}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							disabled={
								!session ||
								session.mcpStatus !== "ready" ||
								setBinding.isPending
							}
							onClick={handleConnect}
						>
							{session?.mcpStatus === "ready"
								? "Connect session"
								: "Connect blocked"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SessionCard({
	session,
	isSelected,
	assignedElsewherePaneName,
	onSelect,
}: {
	session: AutomationSession;
	isSelected: boolean;
	assignedElsewherePaneName: string | null;
	onSelect: () => void;
}) {
	const pillClass = assignedElsewherePaneName
		? "bg-amber-500/15 text-amber-300"
		: session.mcpStatus === "ready"
			? "bg-emerald-500/15 text-emerald-300"
			: session.mcpStatus === "missing"
				? "bg-amber-500/15 text-amber-300"
				: "bg-muted text-muted-foreground";
	const pillLabel = assignedElsewherePaneName
		? "Reassign"
		: session.mcpStatus === "ready"
			? "Ready"
			: session.mcpStatus === "missing"
				? "Needs MCP"
				: "Unknown";
	const note = assignedElsewherePaneName
		? `${session.displayName} is currently controlling ${assignedElsewherePaneName}. Connecting here moves ownership.`
		: session.mcpStatus === "ready"
			? "Browser MCP is configured. Connect will be immediate."
			: session.mcpStatus === "missing"
				? "This session does not currently expose the required browser automation MCP entry."
				: "Could not verify MCP status for this session.";

	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"text-left rounded-xl border p-3 transition-colors",
				isSelected
					? "border-brand/40 bg-brand/10"
					: "border-border bg-card hover:bg-muted/40",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-[13px] font-semibold truncate">
						{session.displayName}
					</div>
					<div className="text-[11px] text-muted-foreground truncate">
						{session.provider} · {session.branchOrContextLabel}
					</div>
				</div>
				<span
					className={cn(
						"shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
						pillClass,
					)}
				>
					{pillLabel}
				</span>
			</div>
			<div className="mt-2 flex flex-wrap gap-1.5">
				<Tag>{session.kind}</Tag>
				<Tag>{session.branchOrContextLabel}</Tag>
				<Tag>Last active {session.lastActiveAt}</Tag>
			</div>
			<div className="mt-2 text-[11px] leading-snug text-muted-foreground">
				{note}
			</div>
		</button>
	);
}

function Tag({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
			{children}
		</span>
	);
}

function ReadyPanel({
	session,
	paneName,
	reassigning,
	previousPaneName,
}: {
	session: AutomationSession;
	paneName: string;
	reassigning: boolean;
	previousPaneName: string | null;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">
					Selected session is ready to connect
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					This session already has the browser automation MCP entry, so the
					connect action will immediately bind the pane to this owner.
				</div>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<DetailItem label="Owner">
						{session.displayName} / {session.provider}
					</DetailItem>
					<DetailItem label="Binding mode">Exclusive control</DetailItem>
					<DetailItem label="Pane">{paneName}</DetailItem>
					<DetailItem label="Expected">
						{reassigning
							? `Moves from ${previousPaneName ?? "another pane"}`
							: "Toolbar badge updates instantly"}
					</DetailItem>
				</div>
			</div>
		</div>
	);
}

function DetailItem({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-md bg-muted/40 p-2">
			<span className="block text-[10px] uppercase tracking-wider text-muted-foreground/70">
				{label}
			</span>
			<strong className="block mt-0.5 text-[12px] font-medium">
				{children}
			</strong>
		</div>
	);
}

function SetupPanel({
	session,
	mcpConfigPath,
	onCopy,
}: {
	session: AutomationSession;
	mcpConfigPath: string | null;
	onCopy: () => void;
}) {
	const snippet = getSnippetForSession(session);
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">
					This session needs browser MCP setup
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					The connect action will not fail silently. Add the{" "}
					<code className="rounded bg-muted px-1">superset-browser</code> MCP
					server to {session.provider}, then reload this session.
				</div>
				<ol className="mt-2 pl-4 list-decimal text-[12px] leading-relaxed text-muted-foreground">
					<li>
						Open{" "}
						{mcpConfigPath ? (
							<code className="rounded bg-muted px-1">{mcpConfigPath}</code>
						) : (
							"your agent config file"
						)}
						.
					</li>
					<li>
						Append the <code>superset-browser</code> MCP server block below.
					</li>
					<li>
						Restart {session.displayName} (or run the agent again) so the new
						entry is picked up.
					</li>
				</ol>
				<pre className="mt-2 rounded-md border bg-black/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
					{snippet}
				</pre>
				<div className="mt-3 flex gap-2">
					<Button size="sm" variant="outline" onClick={onCopy}>
						<LuCopy className="size-3" />
						Copy snippet
					</Button>
				</div>
				<div className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
					MCP readiness is detected by inspecting the config file for the string{" "}
					<code>superset-browser</code>. If you prefer a managed location, the
					desktop app also ships the server at <code>packages/desktop-mcp</code>
					.
				</div>
			</div>
		</div>
	);
}
