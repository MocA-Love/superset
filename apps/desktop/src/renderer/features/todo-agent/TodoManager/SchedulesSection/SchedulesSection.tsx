import type { SelectTodoSchedule } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { useMemo, useState } from "react";
import { HiMiniPlus } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type StatusFilterOption,
	StatusFilterPopover,
} from "../components/StatusFilterPopover";
import { ScheduleEditorDialog } from "./components/ScheduleEditorDialog";
import { ScheduleListRow } from "./components/ScheduleListRow";

type ScheduleStatus = "enabled" | "disabled";

const SCHEDULE_STATUS_OPTIONS: readonly StatusFilterOption<ScheduleStatus>[] = [
	{ value: "enabled", label: "有効" },
	{ value: "disabled", label: "無効" },
];

/**
 * Tab shown inside TodoManager's left sidebar when the user flips to
 * "スケジュール". Renders the list of saved schedules plus the editor
 * dialog for creating / updating one.
 */
export function SchedulesSection() {
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<SelectTodoSchedule | null>(null);
	const [filter, setFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<Set<ScheduleStatus>>(
		() => new Set(),
	);

	const { data: schedules } = electronTrpc.todoAgent.schedule.listAll.useQuery(
		undefined,
		{
			refetchInterval: 30_000,
		},
	);
	const { data: workspaces } = electronTrpc.workspaces.getAll.useQuery();
	const { data: projects } = electronTrpc.projects.getRecents.useQuery();

	const workspaceNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const w of workspaces ?? []) map.set(w.id, w.name);
		return map;
	}, [workspaces]);

	const projectNameById = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of projects ?? []) map.set(p.id, p.name);
		return map;
	}, [projects]);

	const filteredSchedules = useMemo(() => {
		const list = schedules ?? [];
		const needle = filter.trim().toLowerCase();
		const hasStatus = statusFilter.size > 0;
		if (!needle && !hasStatus) return list;
		return list.filter((s) => {
			if (hasStatus) {
				const statusKey: ScheduleStatus = s.enabled ? "enabled" : "disabled";
				if (!statusFilter.has(statusKey)) return false;
			}
			if (!needle) return true;
			const wsName = s.workspaceId
				? (workspaceNameById.get(s.workspaceId) ?? "")
				: "";
			const projName = projectNameById.get(s.projectId) ?? "";
			return (
				s.name.toLowerCase().includes(needle) ||
				s.title.toLowerCase().includes(needle) ||
				s.description.toLowerCase().includes(needle) ||
				wsName.toLowerCase().includes(needle) ||
				projName.toLowerCase().includes(needle)
			);
		});
	}, [schedules, filter, statusFilter, workspaceNameById, projectNameById]);

	const openNew = () => {
		setEditing(null);
		setEditorOpen(true);
	};

	const openEdit = (schedule: SelectTodoSchedule) => {
		setEditing(schedule);
		setEditorOpen(true);
	};

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<div className="p-2 border-b shrink-0 flex items-center justify-between gap-2">
				<span className="text-xs text-muted-foreground">
					{(schedules?.length ?? 0) > 0
						? `${schedules?.length} 件のスケジュール`
						: "スケジュールなし"}
				</span>
				<Button
					type="button"
					size="sm"
					className="h-7 gap-1 px-2.5 text-xs rounded-md"
					onClick={openNew}
				>
					<HiMiniPlus className="size-4" />
					新規
				</Button>
			</div>
			<div className="p-2 border-b shrink-0 flex items-center gap-2">
				<Input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="絞り込み（名前 / タイトル / プロジェクト）"
					className="h-8 text-xs rounded-md flex-1 min-w-0"
				/>
				<StatusFilterPopover
					options={SCHEDULE_STATUS_OPTIONS}
					selected={statusFilter}
					onChange={setStatusFilter}
				/>
			</div>
			<ScrollArea className="flex-1 min-h-0">
				<div className="flex flex-col gap-1.5 p-2">
					{(schedules?.length ?? 0) === 0 ? (
						<p className="text-xs text-muted-foreground px-1 py-4">
							まだスケジュールはありません。「新規」ボタンから作成してください。
							<br />
							<span className="text-[10px]">
								スケジュールはアプリ起動中のみ発火します。
							</span>
						</p>
					) : filteredSchedules.length === 0 ? (
						<p className="text-xs text-muted-foreground px-1 py-4">
							条件に一致するスケジュールがありません。
						</p>
					) : (
						filteredSchedules.map((schedule) => (
							<ScheduleListRow
								key={schedule.id}
								schedule={schedule}
								projectName={projectNameById.get(schedule.projectId) ?? null}
								workspaceName={
									schedule.workspaceId
										? (workspaceNameById.get(schedule.workspaceId) ?? null)
										: null
								}
								onEdit={() => openEdit(schedule)}
							/>
						))
					)}
				</div>
			</ScrollArea>

			<ScheduleEditorDialog
				open={editorOpen}
				onOpenChange={setEditorOpen}
				initial={editing}
			/>
		</div>
	);
}
