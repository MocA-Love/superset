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
import { useEffect, useMemo, useState } from "react";
import { LuList, LuPlug, LuShield } from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AutomationSession,
	getSnippetForSession,
	type ServerCommand,
	useBrowserAutomationStore,
} from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";
import { CdpEndpointCard } from "./components/CdpEndpointCard";
import { McpInstallPanel } from "./components/McpInstallPanel";
import { PermissionsTab } from "./components/PermissionsTab";

interface SessionConnectModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SessionConnectModal({
	open,
	onOpenChange,
}: SessionConnectModalProps) {
	const [activeTab, setActiveTab] = useState<"sessions" | "permissions">(
		"sessions",
	);
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

	const serverCommand = mcpStatus?.serverCommand as ServerCommand | undefined;

	const handleCopySnippet = async () => {
		if (!session) return;
		try {
			await navigator.clipboard.writeText(
				getSnippetForSession(session, serverCommand),
			);
			toast.success("Configuration snippet copied");
		} catch {
			toast.error("Failed to copy snippet");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!max-w-[min(1640px,95vw)] sm:!max-w-[min(1640px,95vw)] p-0 gap-0 overflow-hidden">
				<DialogHeader className="px-5 py-4 border-b">
					<DialogTitle className="text-sm">
						Connect browser automation
					</DialogTitle>
					<DialogDescription className="text-xs">
						Choose which running LLM session should control this browser pane.
					</DialogDescription>
					<div className="mt-3 flex items-center gap-1 border-b -mb-4 pb-0">
						<TabButton
							active={activeTab === "sessions"}
							onClick={() => setActiveTab("sessions")}
						>
							<LuList className="size-3.5" />
							Sessions
						</TabButton>
						<TabButton
							active={activeTab === "permissions"}
							onClick={() => setActiveTab("permissions")}
						>
							<LuShield className="size-3.5" />
							Permissions
						</TabButton>
					</div>
				</DialogHeader>

				{activeTab === "permissions" ? (
					<PermissionsTab />
				) : (
					<>
						<WorkspaceBindingsSummary
							sessions={sessions}
							bindingsByPane={bindingsByPane}
							onOpenAllPanes={() => {
								onOpenChange(false);
								setListViewOpen(true);
							}}
						/>
						<div className="grid grid-cols-[minmax(320px,1fr)_minmax(280px,0.9fr)] min-h-[min(570px,70vh)] max-h-[min(840px,85vh)]">
							<div className="overflow-y-auto p-4 border-r">
								<PaneIdentityCard
									paneName={paneName}
									paneUrl={paneUrl}
									currentSession={currentSession}
									onDisconnect={currentBinding ? handleDisconnect : undefined}
									disconnectPending={removeBinding.isPending}
								/>

								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1 mb-2">
									Running sessions
								</div>

								{sessions.length === 0 ? (
									<div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
										No running LLM sessions found. Start a TODO-Agent session or
										run `claude` / `codex` in any terminal pane, then return
										here.
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
													attachedToThisPane={s.id === currentBinding}
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
											attachedToThisPane={session.id === currentBinding}
										/>
									) : (
										<SetupPanel
											session={session}
											mcpConfigPath={
												session.provider === "Codex"
													? (mcpStatus?.codexConfigPath ?? null)
													: (mcpStatus?.claudeConfigPath ?? null)
											}
											serverCommand={serverCommand}
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
					</>
				)}

				{activeTab === "sessions" && (
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
				)}
			</DialogContent>
		</Dialog>
	);
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 transition-colors",
				active
					? "border-brand text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function WorkspaceBindingsSummary({
	sessions,
	bindingsByPane,
	onOpenAllPanes,
}: {
	sessions: AutomationSession[];
	bindingsByPane: Record<string, string>;
	onOpenAllPanes: () => void;
}) {
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const liveSessionIds = new Set(sessions.map((s) => s.id));
	const browserPanes = useMemo(() => {
		const tabById = new Map(tabs.map((t) => [t.id, t]));
		return Object.values(panes).filter((p) => {
			if (p.type !== "webview") return false;
			const tab = tabById.get(p.tabId);
			return Boolean(tab);
		});
	}, [panes, tabs]);

	const connected = browserPanes.filter((p) => {
		const sid = bindingsByPane[p.id];
		return sid && liveSessionIds.has(sid);
	}).length;
	const unassigned = browserPanes.length - connected;
	const needsSetup = sessions.filter((s) => s.mcpStatus === "missing").length;

	return (
		<div className="px-5 py-2 border-b flex items-center gap-3 text-[11px] bg-muted/20">
			<span className="text-muted-foreground uppercase tracking-wider text-[10px] font-semibold">
				Workspace bindings
			</span>
			<span className="flex items-center gap-1.5">
				<span className="size-1.5 rounded-full bg-emerald-400" />
				{connected} connected
			</span>
			<span className="flex items-center gap-1.5 text-muted-foreground">
				<span className="size-1.5 rounded-full bg-muted-foreground/50" />
				{unassigned} unassigned
			</span>
			{needsSetup > 0 && (
				<span className="flex items-center gap-1.5 text-amber-400">
					<span className="size-1.5 rounded-full bg-amber-400" />
					{needsSetup} needs setup
				</span>
			)}
			<button
				type="button"
				onClick={onOpenAllPanes}
				className="ml-auto inline-flex items-center gap-1 text-brand hover:underline"
			>
				<LuList className="size-3" />
				Open all panes view →
			</button>
		</div>
	);
}

function PaneIdentityCard({
	paneName,
	paneUrl,
	currentSession,
	onDisconnect,
	disconnectPending,
}: {
	paneName: string;
	paneUrl: string;
	currentSession: AutomationSession | null;
	onDisconnect?: () => void;
	disconnectPending?: boolean;
}) {
	const isConnected = currentSession !== null;
	return (
		<div
			className={cn(
				"rounded-xl border p-3 mb-3",
				isConnected
					? "border-brand/30 bg-brand/5"
					: "border-border bg-muted/40",
			)}
		>
			<div className="flex items-start gap-3">
				<div className="flex size-9 items-center justify-center rounded-lg bg-brand/15 text-brand text-base font-bold shrink-0">
					<LuPlug className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<div className="text-[13px] font-semibold truncate">{paneName}</div>
						<span
							className={cn(
								"shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
								isConnected
									? "bg-emerald-500/15 text-emerald-300"
									: "bg-muted text-muted-foreground",
							)}
						>
							{isConnected ? "Connected" : "Unassigned"}
						</span>
					</div>
					<div className="text-[11px] text-muted-foreground truncate">
						{paneUrl}
					</div>
					<div className="mt-1.5 text-[11px] flex items-center gap-1.5 flex-wrap">
						{isConnected ? (
							<>
								<span className="text-muted-foreground">Driven by:</span>
								<span className="font-medium">
									{currentSession.displayName}
								</span>
								<span className="text-muted-foreground">
									({currentSession.provider})
								</span>
							</>
						) : (
							<span className="text-muted-foreground">
								No session is driving this pane yet.
							</span>
						)}
					</div>
				</div>
				{isConnected && onDisconnect && (
					<button
						type="button"
						onClick={onDisconnect}
						disabled={disconnectPending}
						className="h-7 px-2 rounded-md border text-[11px] shrink-0 hover:bg-muted/40 disabled:opacity-50"
					>
						Disconnect
					</button>
				)}
			</div>
		</div>
	);
}

function SessionCard({
	session,
	isSelected,
	attachedToThisPane,
	assignedElsewherePaneName,
	onSelect,
}: {
	session: AutomationSession;
	isSelected: boolean;
	attachedToThisPane: boolean;
	assignedElsewherePaneName: string | null;
	onSelect: () => void;
}) {
	// Pill precedence: "Attached" (bound to THIS pane already) >
	// "Reassign" (bound to a different pane) > MCP readiness label.
	// Showing "Ready" on an already-bound session buried the active
	// binding status, which is the most important thing the user needs
	// to see in this list.
	const pillClass = attachedToThisPane
		? "bg-brand/15 text-brand"
		: assignedElsewherePaneName
			? "bg-amber-500/15 text-amber-300"
			: session.mcpStatus === "ready"
				? "bg-emerald-500/15 text-emerald-300"
				: session.mcpStatus === "missing"
					? "bg-amber-500/15 text-amber-300"
					: "bg-muted text-muted-foreground";
	const pillLabel = attachedToThisPane
		? "● Driving this pane"
		: assignedElsewherePaneName
			? `Driving: ${assignedElsewherePaneName}`
			: session.mcpStatus === "ready"
				? "Ready · Free"
				: session.mcpStatus === "missing"
					? "Needs MCP"
					: "Unknown";
	const note = attachedToThisPane
		? null
		: assignedElsewherePaneName
			? `Connecting here will move ownership from "${assignedElsewherePaneName}".`
			: session.mcpStatus === "missing"
				? "This session does not currently expose the required browser automation MCP entry."
				: session.mcpStatus === "unknown"
					? "Could not verify MCP status for this session."
					: null;

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
						{session.provider} · {session.kind} · {session.branchOrContextLabel}{" "}
						· Last active {session.lastActiveAt}
					</div>
				</div>
				<span
					className={cn(
						"shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider max-w-[55%] truncate",
						pillClass,
					)}
					title={pillLabel}
				>
					{pillLabel}
				</span>
			</div>
			{note && (
				<div
					className={cn(
						"mt-2 text-[11px] leading-snug",
						assignedElsewherePaneName
							? "text-amber-300/80"
							: "text-muted-foreground",
					)}
				>
					{note}
				</div>
			)}
		</button>
	);
}

function ReadyPanel({
	session,
	paneName,
	reassigning,
	previousPaneName,
	attachedToThisPane,
}: {
	session: AutomationSession;
	paneName: string;
	reassigning: boolean;
	previousPaneName: string | null;
	attachedToThisPane: boolean;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">
					{attachedToThisPane
						? "Session is attached to this pane"
						: "Selected session is ready to connect"}
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					{attachedToThisPane
						? "Drive the pane from this session by pointing an external browser MCP at the CDP endpoint below."
						: "This session already has the browser automation MCP entry, so the connect action will immediately bind the pane to this owner."}
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
			{attachedToThisPane && <CdpEndpointCard sessionId={session.id} />}
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
	serverCommand,
}: {
	session: AutomationSession;
	mcpConfigPath: string | null;
	serverCommand?: ServerCommand;
	onCopy: () => void;
}) {
	return <McpInstallPanel serverCommand={serverCommand} />;
}
