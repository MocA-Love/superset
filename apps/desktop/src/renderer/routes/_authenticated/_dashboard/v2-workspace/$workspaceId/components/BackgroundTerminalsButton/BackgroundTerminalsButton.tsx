import type { WorkspaceStore } from "@superset/panes";
import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { workspaceTrpc } from "@superset/workspace-client";
import { Archive, ChevronDown, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { getRelativeTime } from "renderer/screens/main/components/WorkspacesListView/utils";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { PaneViewerData, TerminalPaneData } from "../../types";
import {
	BACKGROUND_TERMINAL_COUNT_REFETCH_INTERVAL_MS,
	BACKGROUND_TERMINAL_LIST_REFETCH_INTERVAL_MS,
	getAttachedTerminalIds,
	getBackgroundTerminalSessions,
} from "./BackgroundTerminalsButton.utils";

interface BackgroundTerminalsButtonProps {
	workspaceId: string;
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
}

export function BackgroundTerminalsButton({
	workspaceId,
	store,
}: BackgroundTerminalsButtonProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [pendingKillTerminalId, setPendingKillTerminalId] = useState<
		string | null
	>(null);
	const tabs = useStore(store, (s) => s.tabs);
	const utils = workspaceTrpc.useUtils();
	const killSession = workspaceTrpc.terminal.killSession.useMutation();
	const attachedTerminalIds = useMemo(
		() => getAttachedTerminalIds(tabs),
		[tabs],
	);
	const backgroundCountInput = useMemo(
		() => ({ workspaceId, attachedTerminalIds }),
		[workspaceId, attachedTerminalIds],
	);
	const backgroundCountQuery =
		workspaceTrpc.terminal.countBackgroundSessions.useQuery(
			backgroundCountInput,
			{
				enabled: !isOpen,
				notifyOnChangeProps: ["data"],
				refetchInterval: isOpen
					? false
					: BACKGROUND_TERMINAL_COUNT_REFETCH_INTERVAL_MS,
				refetchOnWindowFocus: false,
			},
		);
	const sessionsQuery = workspaceTrpc.terminal.listSessions.useQuery(
		{ workspaceId },
		{
			enabled: isOpen,
			refetchInterval: isOpen
				? BACKGROUND_TERMINAL_LIST_REFETCH_INTERVAL_MS
				: false,
			refetchOnWindowFocus: false,
		},
	);

	const backgroundSessions = useMemo(() => {
		const sessions = sessionsQuery.data?.sessions ?? [];
		return getBackgroundTerminalSessions(sessions, attachedTerminalIds);
	}, [sessionsQuery.data?.sessions, attachedTerminalIds]);
	const closedBackgroundSessionCount = backgroundCountQuery.data?.count ?? 0;
	const backgroundSessionCount = isOpen
		? sessionsQuery.data
			? backgroundSessions.length
			: closedBackgroundSessionCount
		: closedBackgroundSessionCount;

	if (backgroundSessionCount === 0) return null;

	const label = `${backgroundSessionCount} background terminal session${
		backgroundSessionCount === 1 ? "" : "s"
	}`;

	const handleAdopt = (terminalId: string) => {
		store.getState().addTab({
			panes: [
				{
					kind: "terminal",
					data: { terminalId, workspaceId } as TerminalPaneData,
				},
			],
		});
		void utils.terminal.listSessions.invalidate({ workspaceId });
		void utils.terminal.countBackgroundSessions.invalidate();
		setIsOpen(false);
	};

	const handleKill = async (terminalId: string) => {
		setPendingKillTerminalId(terminalId);
		try {
			await killSession.mutateAsync({ terminalId, workspaceId });
		} catch (error) {
			console.error(
				"[BackgroundTerminalsButton] Failed to kill session:",
				error,
			);
			toast.error("Failed to close terminal session");
		} finally {
			setPendingKillTerminalId(null);
			void utils.terminal.listSessions.invalidate({ workspaceId });
			void utils.terminal.countBackgroundSessions.invalidate();
		}
	};

	return (
		<DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					className="h-7 gap-1 rounded-md border border-border/60 bg-muted/30 px-2 text-xs text-muted-foreground shadow-none hover:bg-accent/60 hover:text-foreground"
					size="sm"
					type="button"
					variant="ghost"
				>
					<Archive className="size-3.5" />
					<span>{label}</span>
					<ChevronDown className="size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80">
				<DropdownMenuLabel className="text-xs">
					Background terminal sessions
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<div className="max-h-80 overflow-y-auto">
					{sessionsQuery.isFetching && backgroundSessions.length === 0 && (
						<DropdownMenuItem disabled className="text-xs">
							Loading terminal sessions...
						</DropdownMenuItem>
					)}
					{backgroundSessions.map((session) => (
						<DropdownMenuItem
							key={session.terminalId}
							className="group flex items-center gap-2"
							onSelect={() => handleAdopt(session.terminalId)}
						>
							<Archive className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate text-xs">
								{session.title ?? "Terminal"}
							</span>
							{typeof session.createdAt === "number" &&
								session.createdAt > 0 && (
									<span className="shrink-0 text-xs text-muted-foreground/70">
										{getRelativeTime(session.createdAt, { format: "compact" })}
									</span>
								)}
							<button
								aria-label="Close terminal session"
								className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-30 group-hover:opacity-100"
								disabled={pendingKillTerminalId === session.terminalId}
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									void handleKill(session.terminalId);
								}}
								title="Close terminal session"
								type="button"
							>
								<Trash2 className="size-3" />
							</button>
						</DropdownMenuItem>
					))}
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
