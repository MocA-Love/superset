import type { SelectTodoSession } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";

interface TodoPanelProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
}

/**
 * Right-side drawer that lists autonomous TODO sessions for the current
 * workspace, shows live status of the selected session, and exposes
 * Start / Abort / Send-input controls. The worker itself runs in a
 * normal terminal tab in the workspace so anyone can open it to watch.
 */
export function TodoPanel({ open, onOpenChange, workspaceId }: TodoPanelProps) {
	const { data: sessions } = electronTrpc.todoAgent.list.useQuery(
		{ workspaceId },
		{ enabled: open && !!workspaceId, refetchInterval: 2000 },
	);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = useMemo(
		() => sessions?.find((s) => s.id === selectedId) ?? sessions?.[0],
		[sessions, selectedId],
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-[540px] sm:max-w-[540px] p-0">
				<SheetHeader className="px-5 pt-5 pb-3 border-b">
					<SheetTitle>TODO autonomous sessions</SheetTitle>
					<SheetDescription>
						Sessions for this workspace. Click Start to hand off a queued
						session to the supervisor.
					</SheetDescription>
				</SheetHeader>
				<div className="grid grid-cols-[200px_1fr] h-[calc(100%-90px)]">
					<ScrollArea className="border-r">
						<div className="flex flex-col p-2 gap-1">
							{(sessions ?? []).length === 0 && (
								<p className="text-xs text-muted-foreground px-2 py-4">
									No sessions yet. Create one from the TODO button.
								</p>
							)}
							{(sessions ?? []).map((session) => (
								<button
									key={session.id}
									type="button"
									onClick={() => setSelectedId(session.id)}
									className={cn(
										"text-left rounded-md px-2 py-1.5 text-xs hover:bg-accent",
										selected?.id === session.id && "bg-accent",
									)}
								>
									<div className="font-medium line-clamp-1">
										{session.title}
									</div>
									<div className="text-[10px] text-muted-foreground">
										{statusLabel(session)}
									</div>
								</button>
							))}
						</div>
					</ScrollArea>
					<ScrollArea>
						{selected ? (
							<TodoSessionDetail
								session={selected}
								workspaceId={workspaceId}
							/>
						) : (
							<div className="p-4 text-sm text-muted-foreground">
								Select a session to view details.
							</div>
						)}
					</ScrollArea>
				</div>
			</SheetContent>
		</Sheet>
	);
}

interface TodoSessionDetailProps {
	session: SelectTodoSession;
	workspaceId: string;
}

function TodoSessionDetail({ session, workspaceId }: TodoSessionDetailProps) {
	const [intervention, setIntervention] = useState("");
	const [starting, setStarting] = useState(false);

	const utils = electronTrpc.useUtils();
	const attachPane = electronTrpc.todoAgent.attachPane.useMutation();
	const abort = electronTrpc.todoAgent.abort.useMutation();
	const sendInput = electronTrpc.todoAgent.sendInput.useMutation();
	const createOrAttach = electronTrpc.terminal.createOrAttach.useMutation();
	const write = electronTrpc.terminal.write.useMutation();

	const isActive =
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";

	const canStart = session.status === "queued";

	const handleStart = useCallback(async () => {
		if (!canStart) return;
		setStarting(true);
		try {
			// Create a new terminal tab in the workspace; the user can open it
			// from the tab bar to watch the worker live.
			const tabs = useTabsStore.getState();
			const { tabId, paneId } = tabs.addTab(workspaceId);
			tabs.setTabAutoTitle(tabId, `TODO: ${session.title.slice(0, 24)}`);

			// Launch interactive claude code with an initial prompt that
			// points at the goal file the supervisor wrote at creation time.
			const initialPrompt = `Read .superset/todo/${session.id}/goal.md and begin working toward the goal. Stop when you believe a turn is complete; an external verifier will run \`${session.verifyCommand}\` and tell you if another turn is needed.`;
			const command = `claude ${JSON.stringify(initialPrompt)}`;

			await launchCommandInPane({
				paneId,
				tabId,
				workspaceId,
				command,
				createOrAttach: (input) =>
					createOrAttach.mutateAsync(input as never),
				write: (input) => write.mutateAsync(input as never),
			});

			// Hand off to the supervisor. It will drive subsequent iterations
			// by writing follow-up prompts into this same pane.
			await attachPane.mutateAsync({
				sessionId: session.id,
				tabId,
				paneId,
			});

			await utils.todoAgent.list.invalidate({ workspaceId });
			toast.success(`Started: ${session.title}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to start";
			toast.error(message);
		} finally {
			setStarting(false);
		}
	}, [
		attachPane,
		canStart,
		createOrAttach,
		session,
		utils,
		workspaceId,
		write,
	]);

	const handleAbort = useCallback(async () => {
		try {
			await abort.mutateAsync({ sessionId: session.id });
			await utils.todoAgent.list.invalidate({ workspaceId });
			toast.success("Aborted");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to abort",
			);
		}
	}, [abort, session.id, utils, workspaceId]);

	const handleSendInput = useCallback(async () => {
		if (!intervention.trim()) return;
		try {
			await sendInput.mutateAsync({
				sessionId: session.id,
				data: `${intervention}\n`,
			});
			setIntervention("");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to send input",
			);
		}
	}, [intervention, sendInput, session.id]);

	return (
		<div className="flex flex-col gap-4 p-4 text-sm">
			<div>
				<div className="text-xs uppercase tracking-wide text-muted-foreground">
					Status
				</div>
				<div className="font-medium">{statusLabel(session)}</div>
			</div>

			<div>
				<div className="text-xs uppercase tracking-wide text-muted-foreground">
					Title
				</div>
				<div>{session.title}</div>
			</div>

			<div>
				<div className="text-xs uppercase tracking-wide text-muted-foreground">
					Description
				</div>
				<div className="whitespace-pre-wrap text-xs">{session.description}</div>
			</div>

			<div>
				<div className="text-xs uppercase tracking-wide text-muted-foreground">
					Goal
				</div>
				<div className="whitespace-pre-wrap text-xs">{session.goal}</div>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<div>
					<div className="text-xs uppercase tracking-wide text-muted-foreground">
						Verify
					</div>
					<code className="text-xs">{session.verifyCommand}</code>
				</div>
				<div>
					<div className="text-xs uppercase tracking-wide text-muted-foreground">
						Budget
					</div>
					<div className="text-xs">
						{session.iteration}/{session.maxIterations} iter ·{" "}
						{Math.round(session.maxWallClockSec / 60)}m cap
					</div>
				</div>
			</div>

			{session.verdictReason && (
				<div>
					<div className="text-xs uppercase tracking-wide text-muted-foreground">
						Last verdict
					</div>
					<pre className="text-[11px] bg-muted rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
						{session.verdictReason}
					</pre>
				</div>
			)}

			<div className="flex gap-2 pt-2 border-t">
				{canStart && (
					<Button
						type="button"
						size="sm"
						onClick={handleStart}
						disabled={starting}
					>
						{starting ? "Starting…" : "Start"}
					</Button>
				)}
				{isActive && !canStart && (
					<Button
						type="button"
						size="sm"
						variant="destructive"
						onClick={handleAbort}
					>
						Abort
					</Button>
				)}
			</div>

			{isActive && !canStart && session.attachedPaneId && (
				<div className="flex gap-2">
					<Input
						value={intervention}
						onChange={(e) => setIntervention(e.target.value)}
						placeholder="Type to intervene (sent to worker terminal)"
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSendInput();
							}
						}}
					/>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={handleSendInput}
						disabled={!intervention.trim()}
					>
						Send
					</Button>
				</div>
			)}

			<p className="text-[11px] text-muted-foreground pt-2 border-t">
				Tip: the worker runs in a normal terminal tab in this workspace.
				Open that tab from the tab bar to watch it live or type directly.
			</p>
		</div>
	);
}

function statusLabel(session: SelectTodoSession): string {
	const iter = session.iteration ? ` · iter ${session.iteration}` : "";
	return `${session.status}${iter}`;
}
