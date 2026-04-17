import type { SelectTodoSchedule } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useMemo, useRef, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type ClaudeEffortPick,
	type ClaudeModelPick,
	ClaudeRuntimePicker,
	DEFAULT_SENTINEL,
	fromPersistedEffort,
	fromPersistedModel,
	toPersistedEffort,
	toPersistedModel,
} from "../../../../ClaudeRuntimePicker";
import { describeSchedule } from "../../utils/describeSchedule";
import { formatNextRun } from "../../utils/formatNextRun";
import { FrequencyPicker, type FrequencyValue } from "../FrequencyPicker";

interface ScheduleEditorDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initial: SelectTodoSchedule | null;
	onSaved?: () => void;
}

const DEFAULT_FREQUENCY: FrequencyValue = {
	frequency: "daily",
	minute: 0,
	hour: 9,
	weekday: null,
	monthday: null,
	cronExpr: null,
};

// Sentinel for the "run on the project's main repo (no specific worktree)"
// option in the 実行対象 Select. Kept out of the persisted workspaceId
// space — translated to null when saving, and back to empty string when
// loading an initial row with workspaceId = null.
const MAIN_REPO_SENTINEL = "__main__";

export function ScheduleEditorDialog({
	open,
	onOpenChange,
	initial,
	onSaved,
}: ScheduleEditorDialogProps) {
	const { data: workspaces } = electronTrpc.workspaces.getAll.useQuery();
	const { data: projects } = electronTrpc.projects.getRecents.useQuery();
	const { data: todoSettings } = electronTrpc.todoAgent.settings.get.useQuery(
		undefined,
		{ enabled: open },
	);

	const [name, setName] = useState("");
	const [projectId, setProjectId] = useState<string>("");
	// Empty string = "プロジェクト本体 (main repo)" — resolved to the
	// project's branch workspace at fire time. Otherwise a specific
	// worktree workspace id.
	const [workspaceId, setWorkspaceId] = useState<string>("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [goal, setGoal] = useState("");
	const [verifyCommand, setVerifyCommand] = useState("");
	const [customSystemPrompt, setCustomSystemPrompt] = useState("");
	const [maxIterations, setMaxIterations] = useState(10);
	const [maxWallClockMin, setMaxWallClockMin] = useState(30);
	const [overlapMode, setOverlapMode] = useState<"skip" | "queue">("skip");
	const [autoSyncBeforeFire, setAutoSyncBeforeFire] = useState(false);
	const [enabled, setEnabled] = useState(true);
	const [freq, setFreq] = useState<FrequencyValue>(DEFAULT_FREQUENCY);
	const [claudeModel, setClaudeModel] =
		useState<ClaudeModelPick>(DEFAULT_SENTINEL);
	const [claudeEffort, setClaudeEffort] =
		useState<ClaudeEffortPick>(DEFAULT_SENTINEL);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!open) return;
		if (initial) {
			setName(initial.name);
			setProjectId(initial.projectId);
			setWorkspaceId(initial.workspaceId ?? "");
			setTitle(initial.title);
			setDescription(initial.description);
			setGoal(initial.goal ?? "");
			setVerifyCommand(initial.verifyCommand ?? "");
			setCustomSystemPrompt(initial.customSystemPrompt ?? "");
			setMaxIterations(initial.maxIterations);
			setMaxWallClockMin(Math.round(initial.maxWallClockSec / 60));
			setOverlapMode(initial.overlapMode);
			setAutoSyncBeforeFire(initial.autoSyncBeforeFire);
			setEnabled(initial.enabled);
			setFreq({
				frequency: initial.frequency,
				minute: initial.minute,
				hour: initial.hour,
				weekday: initial.weekday,
				monthday: initial.monthday,
				cronExpr: initial.cronExpr,
			});
			setClaudeModel(fromPersistedModel(initial.claudeModel));
			setClaudeEffort(fromPersistedEffort(initial.claudeEffort));
		} else {
			setName("");
			setProjectId("");
			setWorkspaceId("");
			setTitle("");
			setDescription("");
			setGoal("");
			setVerifyCommand("");
			setCustomSystemPrompt("");
			setMaxIterations(10);
			setMaxWallClockMin(30);
			setOverlapMode("skip");
			setAutoSyncBeforeFire(false);
			setEnabled(true);
			setFreq(DEFAULT_FREQUENCY);
			setClaudeModel(DEFAULT_SENTINEL);
			setClaudeEffort(DEFAULT_SENTINEL);
		}
	}, [open, initial]);

	// Seed the model/effort pickers from the user's global defaults when
	// creating a brand-new schedule (initial === null). Runs at most once
	// per dialog opening so a React Query refetch later can't stomp a
	// manual "デフォルト" pick. When editing an existing schedule, the
	// row's own values are already applied in the reset effect above;
	// this block is intentionally a no-op in that case.
	const claudeSeededRef = useRef(false);
	useEffect(() => {
		if (!open) {
			claudeSeededRef.current = false;
			return;
		}
		if (initial) return;
		if (claudeSeededRef.current) return;
		if (!todoSettings) return;
		setClaudeModel(fromPersistedModel(todoSettings.defaultClaudeModel ?? null));
		setClaudeEffort(
			fromPersistedEffort(todoSettings.defaultClaudeEffort ?? null),
		);
		claudeSeededRef.current = true;
	}, [open, initial, todoSettings]);

	// Pre-select first project when creating a brand-new schedule.
	useEffect(() => {
		if (!open || initial || projectId) return;
		const first = (projects ?? [])[0];
		if (first) setProjectId(first.id);
	}, [open, initial, projectId, projects]);

	// Whenever the chosen project changes, drop a stale workspaceId that
	// no longer belongs to this project so we don't save a cross-project
	// mismatch.
	useEffect(() => {
		if (!workspaceId) return;
		const ws = (workspaces ?? []).find((w) => w.id === workspaceId);
		if (ws && ws.projectId !== projectId) {
			setWorkspaceId("");
		}
	}, [projectId, workspaceId, workspaces]);

	const { data: nextRunPreview } =
		electronTrpc.todoAgent.schedule.previewNextRun.useQuery({
			frequency: freq.frequency,
			minute: freq.minute,
			hour: freq.hour,
			weekday: freq.weekday,
			monthday: freq.monthday,
			cronExpr: freq.cronExpr,
		});

	const createMut = electronTrpc.todoAgent.schedule.create.useMutation();
	const updateMut = electronTrpc.todoAgent.schedule.update.useMutation();

	const cadenceLabel = useMemo(() => describeSchedule(freq), [freq]);

	const canSubmit =
		name.trim().length > 0 &&
		projectId.length > 0 &&
		title.trim().length > 0 &&
		description.trim().length > 0 &&
		(freq.frequency !== "custom" ||
			(freq.cronExpr && freq.cronExpr.trim().length > 0));

	const handleSubmit = async () => {
		if (!canSubmit || submitting) return;

		setSubmitting(true);
		try {
			const payload = {
				projectId,
				workspaceId: workspaceId.length > 0 ? workspaceId : null,
				name: name.trim(),
				enabled,
				frequency: freq.frequency,
				minute: freq.minute,
				hour: freq.hour,
				weekday: freq.weekday,
				monthday: freq.monthday,
				cronExpr: freq.cronExpr,
				title: title.trim(),
				description: description.trim(),
				goal: goal.trim().length > 0 ? goal.trim() : null,
				verifyCommand:
					verifyCommand.trim().length > 0 ? verifyCommand.trim() : null,
				customSystemPrompt:
					customSystemPrompt.trim().length > 0
						? customSystemPrompt.trim()
						: null,
				claudeModel: toPersistedModel(claudeModel),
				claudeEffort: toPersistedEffort(claudeEffort),
				maxIterations,
				maxWallClockSec: maxWallClockMin * 60,
				overlapMode,
				autoSyncBeforeFire,
			};

			if (initial) {
				// projectId is immutable server-side and the Select is
				// disabled while editing; strip it here too so a stale
				// local state can't ever silently request a project
				// change that the backend would ignore.
				const { projectId: _omitProjectId, ...updatePayload } = payload;
				await updateMut.mutateAsync({
					id: initial.id,
					...updatePayload,
				});
				toast.success("スケジュールを更新しました");
			} else {
				await createMut.mutateAsync(payload);
				toast.success("スケジュールを作成しました");
			}

			onSaved?.();
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`保存に失敗しました: ${message}`);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!w-[min(1280px,92vw)] !max-w-[min(1280px,92vw)] sm:!max-w-[min(1280px,92vw)] max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{initial ? "スケジュールを編集" : "新しいスケジュール"}
					</DialogTitle>
					<DialogDescription>
						アプリ起動中に指定時刻が来ると TODO セッションが自動作成されます。
					</DialogDescription>
				</DialogHeader>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">スケジュール名</Label>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="例: 毎日デプロイ"
								className="h-8 text-xs"
								autoFocus
								disabled={submitting}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">プロジェクト</Label>
							<Select
								value={projectId}
								onValueChange={setProjectId}
								disabled={submitting || initial !== null}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue placeholder="プロジェクトを選択" />
								</SelectTrigger>
								<SelectContent>
									{(projects ?? []).map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{initial !== null && (
								<p className="text-[10px] text-muted-foreground">
									プロジェクトは編集できません。変更したい場合はスケジュールを作り直してください。
								</p>
							)}
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">実行対象</Label>
							<Select
								value={workspaceId || MAIN_REPO_SENTINEL}
								onValueChange={(v) =>
									setWorkspaceId(v === MAIN_REPO_SENTINEL ? "" : v)
								}
								disabled={submitting || !projectId}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={MAIN_REPO_SENTINEL}>
										プロジェクト本体 (main)
									</SelectItem>
									{(workspaces ?? [])
										.filter(
											(w) => w.projectId === projectId && w.type === "worktree",
										)
										.map((w) => (
											<SelectItem key={w.id} value={w.id}>
												{w.name}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>

						<FrequencyPicker
							value={freq}
							onChange={setFreq}
							disabled={submitting}
						/>

						<div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
							<div>
								<span className="text-muted-foreground">発火: </span>
								<span>{cadenceLabel}</span>
							</div>
							<div>
								<span className="text-muted-foreground">次回: </span>
								<span>{formatNextRun(nextRunPreview ?? null)}</span>
							</div>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">前回が実行中の時</Label>
							<Select
								value={overlapMode}
								onValueChange={(v) => setOverlapMode(v as "skip" | "queue")}
								disabled={submitting}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="skip">スキップ</SelectItem>
									<SelectItem value="queue">キューに追加</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{!workspaceId && (
							<div className="flex items-start gap-2 mt-1">
								<input
									id="schedule-auto-sync"
									type="checkbox"
									checked={autoSyncBeforeFire}
									onChange={(e) => setAutoSyncBeforeFire(e.target.checked)}
									disabled={submitting}
									className="size-4 mt-0.5"
								/>
								<Label
									htmlFor="schedule-auto-sync"
									className="text-xs cursor-pointer leading-4"
								>
									実行前に main ブランチを最新化する
									<span className="block text-[10px] text-muted-foreground mt-0.5">
										git fetch / checkout / pull --ff-only を実行。
										未コミット変更があるときはその回の実行をスキップします。
									</span>
								</Label>
							</div>
						)}

						<div className="flex items-center gap-2 mt-1">
							<input
								id="schedule-enabled"
								type="checkbox"
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
								disabled={submitting}
								className="size-4"
							/>
							<Label
								htmlFor="schedule-enabled"
								className="text-xs cursor-pointer"
							>
								有効
							</Label>
						</div>
					</div>

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">TODO タイトル</Label>
							<Input
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="発火時に作られる TODO の見出し"
								className="h-8 text-xs"
								disabled={submitting}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">やって欲しいこと</Label>
							<Textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="例: 本番 api を最新の main からデプロイしてヘルスチェックが通ったら終了"
								className="min-h-[96px] text-xs resize-y"
								disabled={submitting}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">
								ゴール <span className="text-muted-foreground">(任意)</span>
							</Label>
							<Textarea
								value={goal}
								onChange={(e) => setGoal(e.target.value)}
								placeholder="完了判定の要件があれば"
								className="min-h-[60px] text-xs resize-y"
								disabled={submitting}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">
								verify コマンド{" "}
								<span className="text-muted-foreground">(任意)</span>
							</Label>
							<Input
								value={verifyCommand}
								onChange={(e) => setVerifyCommand(e.target.value)}
								placeholder="例: curl -fsS https://example.com/health"
								className="h-8 text-xs font-mono"
								disabled={submitting}
							/>
						</div>

						<div className="flex items-center gap-2">
							<div className="flex flex-col gap-1 flex-1">
								<Label className="text-xs">最大反復回数</Label>
								<Input
									type="number"
									min={1}
									max={100}
									value={maxIterations}
									onChange={(e) =>
										setMaxIterations(
											Math.max(1, Math.min(100, Number(e.target.value) || 1)),
										)
									}
									disabled={submitting}
									className="h-8 text-xs"
								/>
							</div>
							<div className="flex flex-col gap-1 flex-1">
								<Label className="text-xs">最大実行時間 (分)</Label>
								<Input
									type="number"
									min={1}
									max={240}
									value={maxWallClockMin}
									onChange={(e) =>
										setMaxWallClockMin(
											Math.max(1, Math.min(240, Number(e.target.value) || 1)),
										)
									}
									disabled={submitting}
									className="h-8 text-xs"
								/>
							</div>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs">
								システムプロンプト{" "}
								<span className="text-muted-foreground">(任意)</span>
							</Label>
							<Textarea
								value={customSystemPrompt}
								onChange={(e) => setCustomSystemPrompt(e.target.value)}
								placeholder="Claude に毎回追加で渡すシステムプロンプト"
								className="min-h-[60px] text-xs resize-y"
								disabled={submitting}
							/>
						</div>

						<ClaudeRuntimePicker
							model={claudeModel}
							effort={claudeEffort}
							onModelChange={setClaudeModel}
							onEffortChange={setClaudeEffort}
							disabled={submitting}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						キャンセル
					</Button>
					<Button
						type="button"
						onClick={() => void handleSubmit()}
						disabled={!canSubmit || submitting}
					>
						{submitting ? (
							<LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
						) : null}
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
