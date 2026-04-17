import type { SelectTodoSchedule } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { cn } from "@superset/ui/utils";
import {
	HiMiniEllipsisVertical,
	HiMiniPencil,
	HiMiniTrash,
} from "react-icons/hi2";
import {
	getClaudeEffortLabel,
	getClaudeModelLabel,
} from "renderer/features/todo-agent/ClaudeRuntimePicker";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { describeSchedule } from "../../utils/describeSchedule";
import { formatNextRun } from "../../utils/formatNextRun";

interface ScheduleListRowProps {
	schedule: SelectTodoSchedule;
	projectName: string | null;
	workspaceName: string | null;
	onEdit: () => void;
}

export function ScheduleListRow({
	schedule,
	projectName,
	workspaceName,
	onEdit,
}: ScheduleListRowProps) {
	const utils = electronTrpc.useUtils();
	const setEnabledMut =
		electronTrpc.todoAgent.schedule.setEnabled.useMutation();
	const deleteMut = electronTrpc.todoAgent.schedule.delete.useMutation();

	const handleToggle = async (next: boolean) => {
		try {
			await setEnabledMut.mutateAsync({ id: schedule.id, enabled: next });
			await utils.todoAgent.schedule.listAll.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`更新に失敗しました: ${message}`);
		}
	};

	const handleDelete = async () => {
		if (!window.confirm(`スケジュール「${schedule.name}」を削除しますか？`))
			return;
		try {
			await deleteMut.mutateAsync({ id: schedule.id });
			await utils.todoAgent.schedule.listAll.invalidate();
			toast.success("スケジュールを削除しました");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`削除に失敗しました: ${message}`);
		}
	};

	return (
		<div
			className={cn(
				"flex items-start gap-2 p-2 rounded-md border bg-card hover:bg-accent/40 transition-colors",
				!schedule.enabled && "opacity-60",
			)}
		>
			<Switch
				checked={schedule.enabled}
				onCheckedChange={(v) => void handleToggle(v)}
				className="mt-0.5"
			/>
			<button
				type="button"
				onClick={onEdit}
				className="flex-1 min-w-0 text-left"
			>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium truncate">{schedule.name}</span>
				</div>
				<div className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
					<span>{describeSchedule(schedule)}</span>
					<span>→ {formatNextRun(schedule.nextRunAt)}</span>
					<span className="truncate">
						{projectName ?? "(不明なプロジェクト)"}
						{workspaceName ? ` / ${workspaceName}` : " / main"}
					</span>
				</div>
				<div className="text-[10px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
					<span>Model: {getClaudeModelLabel(schedule.claudeModel)}</span>
					<span>Effort: {getClaudeEffortLabel(schedule.claudeEffort)}</span>
				</div>
				{schedule.lastRunAt && (
					<div className="text-[10px] text-muted-foreground mt-0.5">
						最終: {new Date(schedule.lastRunAt).toLocaleString("ja-JP")}
					</div>
				)}
			</button>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 w-7 p-0 shrink-0"
					>
						<HiMiniEllipsisVertical className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						onSelect={() => {
							// Defer opening the editor Dialog so the dropdown's own
							// pointer-up / focus-return doesn't race with Dialog's
							// outside-click detection and immediately close it.
							setTimeout(onEdit, 0);
						}}
					>
						<HiMiniPencil className="mr-2 size-4" />
						編集
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => {
							setTimeout(() => void handleDelete(), 0);
						}}
						className="text-destructive focus:text-destructive"
					>
						<HiMiniTrash className="mr-2 size-4" />
						削除
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
