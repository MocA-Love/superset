import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { memo, useState } from "react";
import { HiMiniListBullet } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TodoModal } from "../TodoModal";

interface TodoButtonProps {
	projectId?: string | null;
	workspaceId: string;
	worktreePath?: string | null;
}

/**
 * Fork-local TODO autonomous agent entry point. Sits immediately left of
 * the WorkspaceRunButton in PresetsBar. Opens a modal where the user
 * specifies a goal; the modal submits via trpc and the supervisor takes
 * over from there.
 */
export const TodoButton = memo(function TodoButton({
	projectId,
	workspaceId,
}: TodoButtonProps) {
	const [modalOpen, setModalOpen] = useState(false);

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
				onClick={() => setModalOpen(true)}
				title="Create an autonomous TODO task"
			>
				<HiMiniListBullet className="size-4" />
				<span className="font-medium">TODO</span>
				{activeCount > 0 && (
					<span className="ml-1 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums">
						{activeCount}
					</span>
				)}
			</Button>
			<TodoModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				workspaceId={workspaceId}
				projectId={projectId ?? undefined}
			/>
		</>
	);
});
