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
import { useEffect, useMemo, useRef, useState } from "react";
import {
	LuArrowLeft,
	LuLayoutGrid,
	LuList,
	LuPlug,
	LuShield,
	LuTerminal,
} from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AutomationSession,
	getSnippetForSession,
	type ServerCommand,
	useBrowserAutomationStore,
} from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	CdpEndpointCard,
	PlaceholderSetupCommandsCard,
} from "./components/CdpEndpointCard";
import { McpInstallPanel } from "./components/McpInstallPanel";
import { PermissionsTab } from "./components/PermissionsTab";

/**
 * pane.name / userTitle は長大な URL (特に Google 検索結果の query
 * 付き) になることがあり、pill / DetailItem / footer 文言にそのまま流すと
 * モーダルからはみ出す。URL は host + 先頭パスだけに縮め、それ以外は
 * 40 文字でカットしてツールチップに全文を出すための補助。
 */
function shortenPaneLabel(raw: string, max = 40): string {
	if (!raw) return raw;
	try {
		if (raw.startsWith("http://") || raw.startsWith("https://")) {
			const url = new URL(raw);
			const tail = `${url.pathname}${url.search ? "?…" : ""}`;
			const short = `${url.host}${tail}`;
			return short.length > max ? `${short.slice(0, max - 1)}…` : short;
		}
	} catch {
		// fall through to generic truncation
	}
	return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

interface SessionRow {
	session: AutomationSession;
	attachedToThisPane: boolean;
	assignedElsewherePaneName: string | null;
	isInCurrentWorkspace: boolean;
}

function getSessionRowPriority(row: SessionRow): number {
	if (row.attachedToThisPane) return 0;
	if (row.assignedElsewherePaneName) return 2;
	return 1;
}

function getMcpStatusPriority(status: AutomationSession["mcpStatus"]): number {
	if (status === "ready") return 0;
	if (status === "missing") return 1;
	return 2;
}

function compareSessionRows(left: SessionRow, right: SessionRow): number {
	const priorityDiff =
		getSessionRowPriority(left) - getSessionRowPriority(right);
	if (priorityDiff !== 0) return priorityDiff;

	const mcpDiff =
		getMcpStatusPriority(left.session.mcpStatus) -
		getMcpStatusPriority(right.session.mcpStatus);
	if (mcpDiff !== 0) return mcpDiff;

	return (
		left.session.displayName.localeCompare(right.session.displayName) ||
		left.session.provider.localeCompare(right.session.provider) ||
		left.session.paneId.localeCompare(right.session.paneId)
	);
}

interface SessionConnectModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SessionConnectModal({
	open,
	onOpenChange,
}: SessionConnectModalProps) {
	const [activeTab, setActiveTab] = useState<
		"sessions" | "workspace" | "permissions"
	>("sessions");
	const [showOtherWorkspaces, setShowOtherWorkspaces] = useState(false);
	// Incremented each time the user asks for setup commands from the
	// summary bar; CdpEndpointCard listens and expands its section.
	const [setupRevealToken, setSetupRevealToken] = useState(0);
	const modalInitRef = useRef<{ open: boolean; paneId: string | null }>({
		open: false,
		paneId: null,
	});
	const paneId = useBrowserAutomationStore((s) => s.connectModal.paneId);
	const selectedSessionId = useBrowserAutomationStore(
		(s) => s.connectModal.selectedSessionId,
	);
	const setSelectedSession = useBrowserAutomationStore(
		(s) => s.setSelectedSession,
	);

	const { sessions, bindingsByPane, mcpStatus } = useBrowserAutomationData({
		enabled: open,
	});

	const setBinding = electronTrpc.browserAutomation.setBinding.useMutation();
	const removeBinding =
		electronTrpc.browserAutomation.removeBinding.useMutation();
	const utils = electronTrpc.useUtils();

	const pane = useTabsStore((s) => (paneId ? s.panes[paneId] : null));
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const workspaceId = useMemo(() => {
		if (!pane) return null;
		return tabs.find((t) => t.id === pane.tabId)?.workspaceId ?? null;
	}, [pane, tabs]);

	const currentBinding = paneId ? bindingsByPane[paneId] : null;
	const sessionRows = useMemo(() => {
		const bindingEntries = Object.entries(bindingsByPane);
		return sessions
			.map((session): SessionRow => {
				const assignedElsewherePaneId =
					bindingEntries.find(
						([candidatePaneId, sessionId]) =>
							sessionId === session.id && candidatePaneId !== paneId,
					)?.[0] ?? null;
				return {
					session,
					attachedToThisPane: session.id === currentBinding,
					assignedElsewherePaneName: assignedElsewherePaneId
						? (panes[assignedElsewherePaneId]?.name ?? null)
						: null,
					isInCurrentWorkspace:
						workspaceId !== null && session.workspaceId === workspaceId,
				};
			})
			.sort(compareSessionRows);
	}, [bindingsByPane, currentBinding, paneId, panes, sessions, workspaceId]);
	const sessionRowsById = useMemo(
		() => new Map(sessionRows.map((row) => [row.session.id, row])),
		[sessionRows],
	);
	const sameWorkspaceRows = useMemo(
		() => sessionRows.filter((row) => row.isInCurrentWorkspace),
		[sessionRows],
	);
	const otherWorkspaceRows = useMemo(
		() => sessionRows.filter((row) => !row.isInCurrentWorkspace),
		[sessionRows],
	);
	const session = selectedSessionId
		? (sessionRowsById.get(selectedSessionId)?.session ?? null)
		: null;
	const currentSession = currentBinding
		? (sessionRowsById.get(currentBinding)?.session ?? null)
		: null;

	useEffect(() => {
		if (!open) {
			modalInitRef.current = { open, paneId };
			setShowOtherWorkspaces(false);
			return;
		}

		const shouldInitialize =
			!modalInitRef.current.open || modalInitRef.current.paneId !== paneId;
		if (!shouldInitialize) return;
		if (sessionRows.length === 0) return;

		const selectedIsOtherWorkspace = Boolean(
			selectedSessionId &&
				otherWorkspaceRows.some((row) => row.session.id === selectedSessionId),
		);
		setShowOtherWorkspaces(
			sameWorkspaceRows.length === 0 || selectedIsOtherWorkspace,
		);
		modalInitRef.current = { open, paneId };
	}, [
		open,
		paneId,
		selectedSessionId,
		sessionRows.length,
		sameWorkspaceRows.length,
		otherWorkspaceRows,
	]);

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
		const preferredRows =
			sameWorkspaceRows.length > 0 ? sameWorkspaceRows : otherWorkspaceRows;
		const fallback =
			(bindingIsLive ? currentBinding : null) ??
			preferredRows[0]?.session.id ??
			null;
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
		sameWorkspaceRows,
		otherWorkspaceRows,
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
			<DialogContent className="!max-w-[min(1640px,95vw)] sm:!max-w-[min(1640px,95vw)] h-[min(840px,85vh)] p-0 gap-0 overflow-hidden flex flex-col">
				<DialogHeader className="px-5 py-4 border-b shrink-0">
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
							active={activeTab === "workspace"}
							onClick={() => setActiveTab("workspace")}
						>
							<LuLayoutGrid className="size-3.5" />
							Workspace
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

				{/* Always render the summary bar so the right-side "Show setup
				    commands" button stays in a fixed position across tabs. */}
				<WorkspaceBindingsSummary
					sessions={sessions}
					bindingsByPane={bindingsByPane}
					workspaceId={workspaceId}
					onShowSetup={() => {
						setActiveTab("sessions");
						setSetupRevealToken((n) => n + 1);
					}}
				/>

				{activeTab === "permissions" ? (
					<div className="flex-1 min-h-0">
						<PermissionsTab />
					</div>
				) : activeTab === "workspace" ? (
					<div className="flex-1 min-h-0">
						<WorkspacePanesTab
							workspaceId={workspaceId}
							onClose={() => onOpenChange(false)}
							onSwitchToSessions={() => setActiveTab("sessions")}
						/>
					</div>
				) : (
					<div className="flex-1 min-h-0 grid grid-cols-[minmax(320px,1fr)_minmax(280px,0.9fr)]">
						<div className="overflow-y-auto p-4 border-r">
							<PaneIdentityCard
								paneName={paneName}
								paneUrl={paneUrl}
								currentSession={currentSession}
								hasBinding={Boolean(currentBinding)}
								onDisconnect={currentBinding ? handleDisconnect : undefined}
								disconnectPending={removeBinding.isPending}
							/>

							<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1 mb-2">
								Running sessions
							</div>

							{sessions.length === 0 ? (
								<div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
									No running LLM sessions found. Start a TODO-Agent session or
									run `claude` / `codex` in any terminal pane, then return here.
								</div>
							) : (
								<div className="flex flex-col gap-3">
									<div className="flex items-center justify-between gap-2 px-1">
										<div className="text-[11px] text-muted-foreground">
											Prioritizing sessions from the current workspace.
										</div>
										{otherWorkspaceRows.length > 0 && (
											<button
												type="button"
												onClick={() =>
													setShowOtherWorkspaces((value) => !value)
												}
												className="text-[11px] font-medium text-brand hover:underline"
											>
												{showOtherWorkspaces
													? `Hide ${otherWorkspaceRows.length} other-workspace sessions`
													: `Show ${otherWorkspaceRows.length} other-workspace sessions`}
											</button>
										)}
									</div>

									{sameWorkspaceRows.length > 0 ? (
										<SessionSection
											title="Current workspace"
											description={`${sameWorkspaceRows.length} session${sameWorkspaceRows.length === 1 ? "" : "s"}`}
										>
											{sameWorkspaceRows.map((row) => (
												<SessionCard
													key={row.session.id}
													session={row.session}
													isSelected={row.session.id === selectedSessionId}
													attachedToThisPane={row.attachedToThisPane}
													assignedElsewherePaneName={
														row.assignedElsewherePaneName
													}
													isInCurrentWorkspace={row.isInCurrentWorkspace}
													onSelect={() => setSelectedSession(row.session.id)}
												/>
											))}
										</SessionSection>
									) : (
										<div className="rounded-xl border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
											No running LLM sessions were found in this workspace.
										</div>
									)}

									{otherWorkspaceRows.length > 0 &&
										(showOtherWorkspaces || sameWorkspaceRows.length === 0) && (
											<SessionSection
												title="Other workspaces"
												description={`${otherWorkspaceRows.length} session${otherWorkspaceRows.length === 1 ? "" : "s"}`}
											>
												{otherWorkspaceRows.map((row) => (
													<SessionCard
														key={row.session.id}
														session={row.session}
														isSelected={row.session.id === selectedSessionId}
														attachedToThisPane={row.attachedToThisPane}
														assignedElsewherePaneName={
															row.assignedElsewherePaneName
														}
														isInCurrentWorkspace={row.isInCurrentWorkspace}
														onSelect={() => setSelectedSession(row.session.id)}
													/>
												))}
											</SessionSection>
										)}
								</div>
							)}
						</div>

						<div className="overflow-y-auto p-4 bg-muted/20 flex flex-col gap-3">
							{setupRevealToken > 0 && session?.id !== currentBinding && (
								<PlaceholderSetupCommandsCard
									revealToken={setupRevealToken}
									onDismiss={() => setSetupRevealToken(0)}
								/>
							)}
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
										revealSetupToken={setupRevealToken}
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
				)}

				{activeTab === "sessions" && (
					<DialogFooter className="px-5 py-3 border-t gap-2 flex !justify-between">
						<div className="text-[11px] text-muted-foreground min-w-0 flex-1 line-clamp-2 break-words">
							{session?.mcpStatus === "ready"
								? assignedPaneIdForSelected
									? `Connecting will reassign ${session.displayName} from "${shortenPaneLabel(
											panes[assignedPaneIdForSelected]?.name ?? "another pane",
											32,
										)}" to "${shortenPaneLabel(paneName, 32)}".`
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

interface SessionSectionProps {
	title: string;
	description?: string;
	children: React.ReactNode;
}

function SessionSection({ title, description, children }: SessionSectionProps) {
	return (
		<section className="space-y-2">
			<div className="flex items-center justify-between gap-2 px-1">
				<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
					{title}
				</div>
				{description && (
					<div className="text-[10px] text-muted-foreground">{description}</div>
				)}
			</div>
			<div className="flex flex-col gap-2">{children}</div>
		</section>
	);
}

function WorkspaceBindingsSummary({
	sessions,
	bindingsByPane,
	workspaceId,
	onShowSetup,
}: {
	sessions: AutomationSession[];
	bindingsByPane: Record<string, string>;
	workspaceId: string | null;
	onShowSetup: () => void;
}) {
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const liveSessionIds = new Set(sessions.map((s) => s.id));
	// Scope to the current pane's workspace so the summary stays in sync
	// with BrowserAutomationList (which is already workspace-scoped).
	// Falling back to the full set when workspaceId is null keeps the
	// counts non-empty during transient states, but the expected path is
	// always to filter.
	const browserPanes = useMemo(() => {
		const tabById = new Map(tabs.map((t) => [t.id, t]));
		return Object.values(panes).filter((p) => {
			if (p.type !== "webview") return false;
			const tab = tabById.get(p.tabId);
			if (!tab) return false;
			if (workspaceId && tab.workspaceId !== workspaceId) return false;
			return true;
		});
	}, [panes, tabs, workspaceId]);

	let connected = 0;
	let stale = 0;
	for (const p of browserPanes) {
		const sid = bindingsByPane[p.id];
		if (!sid) continue;
		if (liveSessionIds.has(sid)) connected++;
		else stale++;
	}
	const unassigned = browserPanes.length - connected - stale;
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
			{stale > 0 && (
				<span className="flex items-center gap-1.5 text-amber-300">
					<span className="size-1.5 rounded-full bg-amber-400" />
					{stale} stale
				</span>
			)}
			{needsSetup > 0 && (
				<span className="flex items-center gap-1.5 text-amber-400">
					<span className="size-1.5 rounded-full bg-amber-400" />
					{needsSetup} needs setup
				</span>
			)}
			<button
				type="button"
				onClick={onShowSetup}
				className="ml-auto inline-flex items-center gap-1 text-brand hover:underline"
				title="Show MCP setup commands (claude/codex mcp add …)"
			>
				<LuTerminal className="size-3" />
				Show setup commands
			</button>
		</div>
	);
}

function PaneIdentityCard({
	paneName,
	paneUrl,
	currentSession,
	hasBinding,
	onDisconnect,
	disconnectPending,
}: {
	paneName: string;
	paneUrl: string;
	currentSession: AutomationSession | null;
	hasBinding: boolean;
	onDisconnect?: () => void;
	disconnectPending?: boolean;
}) {
	const isConnected = currentSession !== null;
	// Stale binding: binding record exists but the target session is no
	// longer in the live set (e.g. the claude/codex process exited).
	// Surface this explicitly and keep Disconnect available so the user
	// can clear it without first rebinding to another session.
	const isStale = hasBinding && !isConnected;
	const statusLabel = isConnected
		? "Connected"
		: isStale
			? "Session ended"
			: "Unassigned";
	const statusClass = isConnected
		? "bg-emerald-500/15 text-emerald-300"
		: isStale
			? "bg-amber-500/15 text-amber-300"
			: "bg-muted text-muted-foreground";
	return (
		<div
			className={cn(
				"rounded-xl border p-3 mb-3",
				isConnected
					? "border-brand/30 bg-brand/5"
					: isStale
						? "border-amber-500/30 bg-amber-500/5"
						: "border-border bg-muted/40",
			)}
		>
			<div className="flex items-start gap-3">
				<div className="flex size-9 items-center justify-center rounded-lg bg-brand/15 text-brand text-base font-bold shrink-0">
					<LuPlug className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<div
							className="text-[13px] font-semibold truncate"
							title={paneName}
						>
							{shortenPaneLabel(paneName, 50)}
						</div>
						<span
							className={cn(
								"shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
								statusClass,
							)}
						>
							{statusLabel}
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
						) : isStale ? (
							<span className="text-amber-300/80">
								Previous session has ended — disconnect to clear, or pick a new
								one below.
							</span>
						) : (
							<span className="text-muted-foreground">
								No session is driving this pane yet.
							</span>
						)}
					</div>
				</div>
				{hasBinding && onDisconnect && (
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

function WorkspacePanesTab({
	workspaceId,
	onClose,
	onSwitchToSessions,
}: {
	workspaceId: string | null;
	onClose: () => void;
	onSwitchToSessions: () => void;
}) {
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const setActiveTabInStore = useTabsStore((s) => s.setActiveTab);
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);
	const { sessions, bindingsByPane } = useBrowserAutomationData({
		enabled: true,
	});

	const browserPanes = useMemo(() => {
		const tabById = new Map(tabs.map((t) => [t.id, t]));
		return Object.values(panes).filter((p) => {
			if (p.type !== "webview") return false;
			const tab = tabById.get(p.tabId);
			if (!tab) return false;
			if (workspaceId && tab.workspaceId !== workspaceId) return false;
			return true;
		});
	}, [panes, tabs, workspaceId]);

	return (
		<div className="h-full overflow-y-auto">
			{browserPanes.length === 0 ? (
				<div className="text-xs text-muted-foreground text-center py-10">
					No browser panes in this workspace.
				</div>
			) : (
				browserPanes.map((pane, index) => {
					const sessionId = bindingsByPane[pane.id];
					const session = sessionId
						? (sessions.find((s) => s.id === sessionId) ?? null)
						: null;
					const url = pane.browser?.currentUrl ?? pane.url ?? "about:blank";
					// Three-state status, matching PaneIdentityCard:
					// connected (live session), stale (binding exists but session
					// dropped out of the live set), unassigned (no binding).
					const isConnected = session !== null;
					const isStale = sessionId != null && session === null;
					const dotClass = isConnected
						? "bg-emerald-400"
						: isStale
							? "bg-amber-400"
							: "bg-muted-foreground/40";
					const paneDisplay = pane.userTitle || pane.name;
					return (
						<div
							key={pane.id}
							className={cn(
								"flex items-center gap-3 px-5 py-3 hover:bg-muted/20",
								index !== browserPanes.length - 1 && "border-b",
							)}
						>
							<span className={cn("size-2 rounded-full shrink-0", dotClass)} />
							<div className="min-w-0 flex-1">
								<div
									className="text-xs font-semibold truncate"
									title={paneDisplay}
								>
									{shortenPaneLabel(paneDisplay, 50)}
								</div>
								<div
									className="text-[11px] text-muted-foreground truncate"
									title={url}
								>
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
								) : isStale ? (
									<div className="text-[11px] text-amber-300/90 italic truncate">
										Session ended — rebind or disconnect
									</div>
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
										if (workspaceId) {
											setActiveTabInStore(workspaceId, pane.tabId);
										}
										setFocusedPane(pane.tabId, pane.id);
										onClose();
									}}
								>
									Focus
								</Button>
								<Button
									size="sm"
									variant={isConnected ? "outline" : "default"}
									onClick={() => {
										if (workspaceId) {
											setActiveTabInStore(workspaceId, pane.tabId);
										}
										setFocusedPane(pane.tabId, pane.id);
										openConnectModal(pane.id, sessionId);
										onSwitchToSessions();
									}}
								>
									{isConnected ? "Change" : isStale ? "Rebind" : "Connect"}
								</Button>
							</div>
						</div>
					);
				})
			)}
		</div>
	);
}

function SessionCard({
	session,
	isSelected,
	attachedToThisPane,
	assignedElsewherePaneName,
	isInCurrentWorkspace,
	onSelect,
}: {
	session: AutomationSession;
	isSelected: boolean;
	attachedToThisPane: boolean;
	assignedElsewherePaneName: string | null;
	isInCurrentWorkspace: boolean;
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
	const shortOtherPane = assignedElsewherePaneName
		? shortenPaneLabel(assignedElsewherePaneName, 28)
		: null;
	const pillLabel = attachedToThisPane
		? "● Driving this pane"
		: shortOtherPane
			? `Driving: ${shortOtherPane}`
			: session.mcpStatus === "ready"
				? "Ready · Free"
				: session.mcpStatus === "missing"
					? "Needs MCP"
					: "Unknown";
	const pillTooltip = assignedElsewherePaneName ?? pillLabel;
	const note = attachedToThisPane
		? null
		: assignedElsewherePaneName
			? `Connecting here will move ownership from "${shortenPaneLabel(assignedElsewherePaneName, 60)}".`
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
					<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
						<span
							className={cn(
								"rounded-full border px-2 py-0.5",
								isInCurrentWorkspace
									? "border-brand/30 bg-brand/10 text-brand"
									: "border-border bg-muted/40 text-muted-foreground",
							)}
						>
							{isInCurrentWorkspace ? "Current workspace" : "Other workspace"}
						</span>
						{isSelected && isInCurrentWorkspace && (
							<span className="text-brand/80">
								Matching terminal pane is highlighted behind the modal.
							</span>
						)}
					</div>
				</div>
				<span
					className={cn(
						"shrink-0 max-w-[50%] rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider overflow-hidden whitespace-nowrap text-ellipsis",
						pillClass,
					)}
					title={pillTooltip}
				>
					{pillLabel}
				</span>
			</div>
			{note && (
				<div
					className={cn(
						"mt-2 text-[11px] leading-snug break-words",
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
	revealSetupToken,
}: {
	session: AutomationSession;
	paneName: string;
	reassigning: boolean;
	previousPaneName: string | null;
	attachedToThisPane: boolean;
	revealSetupToken?: number;
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
					<DetailItem label="Pane" title={paneName}>
						{shortenPaneLabel(paneName, 60)}
					</DetailItem>
					<DetailItem label="Expected">
						{reassigning
							? `Moves from ${shortenPaneLabel(previousPaneName ?? "another pane", 32)}`
							: "Toolbar badge updates instantly"}
					</DetailItem>
				</div>
			</div>
			{attachedToThisPane && (
				<CdpEndpointCard
					sessionId={session.id}
					revealSetupToken={revealSetupToken}
				/>
			)}
		</div>
	);
}

function DetailItem({
	label,
	children,
	title,
}: {
	label: string;
	children: React.ReactNode;
	title?: string;
}) {
	return (
		<div className="rounded-md bg-muted/40 p-2 min-w-0">
			<span className="block text-[10px] uppercase tracking-wider text-muted-foreground/70">
				{label}
			</span>
			<strong
				className="block mt-0.5 text-[12px] font-medium break-words"
				title={title}
			>
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
