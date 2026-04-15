import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { memo, useState } from "react";
import { HiMiniListBullet } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TodoManager } from "../TodoManager";

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
	workspaceId,
}: TodoButtonProps) {
	const [managerOpen, setManagerOpen] = useState(false);

	const { data: sessions } = electronTrpc.todoAgent.list.useQuery(
		{ workspaceId },
		{ enabled: !!workspaceId, refetchInterval: 3000 },
	);

	const activeCount = (sessions ?? []).filter(
		(session) =>
			session.status === "queued" ||
			session.status === "preparing" ||
			session.status === "running" ||
			session.status === "verifying",
	).length;

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
				{activeCount > 0 && (
					<span className="ml-1 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums">
						{activeCount}
					</span>
				)}
			</Button>
			<TodoManager
				open={managerOpen}
				onOpenChange={setManagerOpen}
				currentWorkspaceId={workspaceId}
			/>
		</>
	);
});
