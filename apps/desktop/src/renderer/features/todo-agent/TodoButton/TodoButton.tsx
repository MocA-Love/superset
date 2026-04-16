import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { memo, useCallback, useState } from "react";
import { HiMiniListBullet } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TodoManager } from "../TodoManager";
import { TodoModal } from "../TodoModal";

interface TodoButtonProps {
	projectId?: string | null;
	workspaceId: string;
	worktreePath?: string | null;
}

/**
 * Entry point for the fork-local TODO autonomous agent feature. Sits
 * immediately left of the WorkspaceRunButton in PresetsBar.
 *
 * Clicking the button opens the Agent-Manager-style TodoManager drawer.
 * Session creation lives inside the manager so users always see the
 * context of what already exists before creating something new.
 */
export const TodoButton = memo(function TodoButton({
	projectId,
	workspaceId,
}: TodoButtonProps) {
	const [managerOpen, setManagerOpen] = useState(false);
	const [modalOpen, setModalOpen] = useState(false);

	const { data: allSessions } = electronTrpc.todoAgent.listAll.useQuery(
		undefined,
		{ refetchInterval: 3000 },
	);

	const runningCount = (allSessions ?? []).filter(
		(s) =>
			s.status === "preparing" ||
			s.status === "running" ||
			s.status === "verifying",
	).length;
	const queuedCount = (allSessions ?? []).filter(
		(s) => s.status === "queued",
	).length;
	// `waiting` is a ScheduleWakeup-paused session that the scheduler will
	// resume automatically. Surface it alongside queued in the badge so the
	// user sees at-a-glance that slots are still spoken for.
	const waitingCount = (allSessions ?? []).filter(
		(s) => s.status === "waiting",
	).length;
	const activeCount = runningCount + queuedCount + waitingCount;

	const handleRequestNewTodo = useCallback(() => {
		setModalOpen(true);
	}, []);

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				className={cn(
					"h-7 gap-1 px-2 text-xs",
					activeCount > 0 && "text-primary",
				)}
				onClick={() => setManagerOpen(true)}
				title="自律 TODO Agent Manager を開く"
			>
				<HiMiniListBullet className="size-4" />
				<span className="font-medium">TODO</span>
				{runningCount > 0 && (
					<span className="relative ml-1 flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums">
						<span className="relative flex size-1.5">
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
							<span className="relative inline-flex size-1.5 rounded-full bg-primary" />
						</span>
						{runningCount}
					</span>
				)}
				{queuedCount + waitingCount > 0 && (
					<span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-foreground">
						+{queuedCount + waitingCount}
					</span>
				)}
			</Button>
			<TodoManager
				open={managerOpen}
				onOpenChange={setManagerOpen}
				currentWorkspaceId={workspaceId}
				onRequestNewTodo={handleRequestNewTodo}
			/>
			{/*
			  Rendered as a sibling of TodoManager rather than inside it so
			  the two shadcn Dialogs stack independently. The modal opens
			  on top of the Manager without the outer Dialog's
			  click-outside handlers interfering.
			*/}
			<TodoModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				workspaceId={workspaceId}
				projectId={projectId ?? undefined}
			/>
		</>
	);
});
