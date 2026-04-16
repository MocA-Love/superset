import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { memo, useCallback, useMemo, useState } from "react";
import { HiMiniListBullet } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TodoManager } from "../TodoManager";
import { TodoModal } from "../TodoModal";

interface TodoButtonProps {
	projectId?: string | null;
	workspaceId: string;
	worktreePath?: string | null;
}

type StatusCategory = "running" | "queued" | "failed" | "paused";

interface StatusBadgeConfig {
	label: string;
	dot: string;
	badge: string;
	pulse?: boolean;
}

const STATUS_BADGE_ORDER: StatusCategory[] = [
	"running",
	"queued",
	"failed",
	"paused",
];

const STATUS_BADGE_META: Record<StatusCategory, StatusBadgeConfig> = {
	running: {
		label: "実行中",
		dot: "bg-amber-500",
		badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
		pulse: true,
	},
	queued: {
		label: "待機中",
		dot: "bg-primary",
		badge: "bg-primary/15 text-primary",
	},
	failed: {
		label: "失敗/要確認",
		dot: "bg-rose-500",
		badge: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
	},
	paused: {
		label: "一時停止",
		dot: "bg-muted-foreground/60",
		badge: "bg-muted text-muted-foreground",
	},
};

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

	const counts = useMemo(() => {
		const acc: Record<StatusCategory, number> = {
			running: 0,
			queued: 0,
			failed: 0,
			paused: 0,
		};
		for (const s of allSessions ?? []) {
			switch (s.status) {
				case "preparing":
				case "running":
				case "verifying":
					acc.running += 1;
					break;
				case "queued":
				case "waiting":
					// `waiting` は ScheduleWakeup で一時停止中のセッション。
					// scheduler が waitingUntil 経過後に自動で queued に戻すため、
					// slot を占有している扱いとして queued と同じバッジで集計する。
					acc.queued += 1;
					break;
				case "failed":
				case "escalated":
					acc.failed += 1;
					break;
				case "paused":
					acc.paused += 1;
					break;
				default:
					break;
			}
		}
		return acc;
	}, [allSessions]);

	const activeCount =
		counts.running + counts.queued + counts.failed + counts.paused;

	const tooltip = useMemo(() => {
		const parts = STATUS_BADGE_ORDER.filter((key) => counts[key] > 0).map(
			(key) => `${STATUS_BADGE_META[key].label}: ${counts[key]}`,
		);
		if (parts.length === 0) return "自律 TODO Agent Manager を開く";
		return `自律 TODO Agent Manager を開く (${parts.join(" / ")})`;
	}, [counts]);

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
					counts.running > 0 && "text-primary",
				)}
				onClick={() => setManagerOpen(true)}
				title={tooltip}
			>
				<HiMiniListBullet className="size-4" />
				<span className="font-medium">TODO</span>
				{activeCount > 0 && (
					<span className="ml-1 flex items-center gap-1">
						{STATUS_BADGE_ORDER.map((key) => {
							const count = counts[key];
							if (count <= 0) return null;
							const meta = STATUS_BADGE_META[key];
							return (
								<span
									key={key}
									className={cn(
										"relative flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums",
										meta.badge,
									)}
								>
									<span className="relative flex size-1.5">
										{meta.pulse && (
											<span
												className={cn(
													"absolute inline-flex size-full animate-ping rounded-full opacity-60",
													meta.dot,
												)}
											/>
										)}
										<span
											className={cn(
												"relative inline-flex size-1.5 rounded-full",
												meta.dot,
											)}
										/>
									</span>
									{count}
								</span>
							);
						})}
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
