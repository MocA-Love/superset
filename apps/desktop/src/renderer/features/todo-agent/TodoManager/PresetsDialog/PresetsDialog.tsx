import type { SelectTodoPromptPreset } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { type AgentKind, DEFAULT_AGENT_KIND } from "main/todo-agent/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	HiMiniCog6Tooth,
	HiMiniPlus,
	HiMiniTrash,
	HiMiniXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	AgentRuntimePicker,
	type ClaudeEffortPick,
	type ClaudeModelPick,
	type CodexEffortPick,
	type CodexModelPick,
	type CrushModelPick,
	DEFAULT_SENTINEL,
	fromPersistedCrushModel,
	fromPersistedEffort,
	fromPersistedModel,
	toPersistedCodexEffort,
	toPersistedCodexModel,
	toPersistedCrushModel,
	toPersistedEffort,
	toPersistedModel,
} from "../../ClaudeRuntimePicker";

interface PresetsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Manager for reusable TODO templates (system prompts, task templates,
 * goal templates). Entered from the "設定" row at the bottom of the
 * Agent Manager's left sidebar. Two-pane layout: list on the left,
 * edit form on the right.
 */
type Tab = "presets" | "settings";

type PresetKind = "system" | "description" | "goal";

const KIND_LABEL: Record<PresetKind, string> = {
	system: "システム",
	description: "タスク",
	goal: "ゴール",
};

export function PresetsDialog({ open, onOpenChange }: PresetsDialogProps) {
	const [tab, setTab] = useState<Tab>("presets");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[960px] max-w-[calc(100vw-4rem)] sm:max-w-[calc(100vw-4rem)] h-[80vh] max-h-[840px] p-0 gap-0 overflow-hidden flex flex-col rounded-xl"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">Agent Manager 設定</DialogTitle>
				<div className="shrink-0 border-b h-12 flex items-center justify-between px-4">
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => setTab("presets")}
							className={cn(
								"px-3 py-1.5 text-xs font-medium rounded-md transition",
								tab === "presets"
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							テンプレート
						</button>
						<button
							type="button"
							onClick={() => setTab("settings")}
							className={cn(
								"px-3 py-1.5 text-xs font-medium rounded-md transition flex items-center gap-1",
								tab === "settings"
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<HiMiniCog6Tooth className="size-3.5" />
							設定
						</button>
					</div>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 w-7 p-0 rounded-md"
						onClick={() => onOpenChange(false)}
						title="閉じる"
					>
						<HiMiniXMark className="size-4" />
					</Button>
				</div>
				{tab === "presets" ? <PresetsTab open={open} /> : <SettingsTab />}
			</DialogContent>
		</Dialog>
	);
}

function SettingsTab() {
	const { data: settings } = electronTrpc.todoAgent.settings.get.useQuery();
	const updateMut = electronTrpc.todoAgent.settings.update.useMutation();
	const utils = electronTrpc.useUtils();
	const { data: crushModelsData } =
		electronTrpc.todoAgent.crushModels.useQuery(undefined);

	const [maxIter, setMaxIter] = useState(10);
	const [maxMin, setMaxMin] = useState(30);
	const [maxConcurrent, setMaxConcurrent] = useState(1);
	const [retentionDays, setRetentionDays] = useState(0);
	const [defaultModel, setDefaultModel] =
		useState<ClaudeModelPick>(DEFAULT_SENTINEL);
	const [defaultEffort, setDefaultEffort] =
		useState<ClaudeEffortPick>(DEFAULT_SENTINEL);
	const [defaultAgentKind, setDefaultAgentKind] =
		useState<AgentKind>(DEFAULT_AGENT_KIND);
	const [defaultCodexModel, setDefaultCodexModel] =
		useState<CodexModelPick>(DEFAULT_SENTINEL);
	const [defaultCodexEffort, setDefaultCodexEffort] =
		useState<CodexEffortPick>(DEFAULT_SENTINEL);
	const [defaultCrushModel, setDefaultCrushModel] =
		useState<CrushModelPick>(DEFAULT_SENTINEL);

	// Hydrate form state the first time settings arrive from the main
	// process. A React Query background refetch (window focus, etc.)
	// re-fires the query even when no persisted data changed; without
	// this guard it would silently clobber in-progress edits in the
	// form, reverting the user's dirty state and erasing their changes
	// the moment the window regained focus.
	const hydratedRef = useRef(false);
	useEffect(() => {
		if (!settings) return;
		if (hydratedRef.current) return;
		setMaxIter(settings.defaultMaxIterations);
		setMaxMin(settings.defaultMaxWallClockMin);
		setMaxConcurrent(settings.maxConcurrentTasks);
		setRetentionDays(settings.sessionRetentionDays);
		setDefaultModel(fromPersistedModel(settings.defaultClaudeModel ?? null));
		setDefaultEffort(fromPersistedEffort(settings.defaultClaudeEffort ?? null));
		setDefaultCrushModel(
			fromPersistedCrushModel(settings.defaultCrushModel ?? null),
		);
		hydratedRef.current = true;
	}, [settings]);

	const dirty =
		settings != null &&
		(maxIter !== settings.defaultMaxIterations ||
			maxMin !== settings.defaultMaxWallClockMin ||
			maxConcurrent !== settings.maxConcurrentTasks ||
			retentionDays !== settings.sessionRetentionDays ||
			toPersistedModel(defaultModel) !==
				(settings.defaultClaudeModel ?? null) ||
			toPersistedEffort(defaultEffort) !==
				(settings.defaultClaudeEffort ?? null) ||
			defaultAgentKind !== (settings.defaultAgentKind ?? DEFAULT_AGENT_KIND) ||
			toPersistedCodexModel(defaultCodexModel) !==
				(settings.defaultCodexModel ?? null) ||
			toPersistedCodexEffort(defaultCodexEffort) !==
				(settings.defaultCodexEffort ?? null) ||
			toPersistedCrushModel(defaultCrushModel) !==
				(settings.defaultCrushModel ?? null));

	const handleSave = useCallback(async () => {
		try {
			await updateMut.mutateAsync({
				defaultMaxIterations: maxIter,
				defaultMaxWallClockMin: maxMin,
				maxConcurrentTasks: maxConcurrent,
				sessionRetentionDays: retentionDays,
				defaultClaudeModel: toPersistedModel(defaultModel),
				defaultClaudeEffort: toPersistedEffort(defaultEffort),
				defaultAgentKind,
				defaultCodexModel: toPersistedCodexModel(defaultCodexModel),
				defaultCodexEffort: toPersistedCodexEffort(defaultCodexEffort),
				defaultCrushModel: toPersistedCrushModel(defaultCrushModel),
			});
			await utils.todoAgent.settings.get.invalidate();
			toast.success("設定を保存しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "保存に失敗しました",
			);
		}
	}, [
		defaultAgentKind,
		defaultCodexEffort,
		defaultCodexModel,
		defaultCrushModel,
		defaultEffort,
		defaultModel,
		maxIter,
		maxMin,
		maxConcurrent,
		retentionDays,
		updateMut,
		utils,
	]);

	return (
		<div className="flex-1 p-6 overflow-y-auto">
			<div className="max-w-md flex flex-col gap-5">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="set-max-iter">デフォルト最大イテレーション数</Label>
					<Input
						id="set-max-iter"
						type="number"
						min={1}
						max={100}
						value={maxIter}
						onChange={(e) => setMaxIter(Number(e.target.value) || 1)}
						className="w-32"
					/>
					<p className="text-[10px] text-muted-foreground">
						新規 TODO 作成時のデフォルト値。各セッションで個別に変更可。
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="set-max-min">デフォルトタイムアウト（分）</Label>
					<Input
						id="set-max-min"
						type="number"
						min={1}
						max={240}
						value={maxMin}
						onChange={(e) => setMaxMin(Number(e.target.value) || 1)}
						className="w-32"
					/>
					<p className="text-[10px] text-muted-foreground">
						壁時計上限。この時間を超えるとセッションはエスカレートされる。
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="set-max-concurrent">最大同時実行数</Label>
					<Input
						id="set-max-concurrent"
						type="number"
						min={1}
						max={10}
						value={maxConcurrent}
						onChange={(e) => setMaxConcurrent(Number(e.target.value) || 1)}
						className="w-32"
					/>
					<p className="text-[10px] text-muted-foreground">
						同時に実行する TODO セッションの上限。超えた分はキューで待機。
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="set-retention-days">セッション自動削除 (日)</Label>
					<Input
						id="set-retention-days"
						type="number"
						min={0}
						max={365}
						value={retentionDays}
						onChange={(e) =>
							setRetentionDays(Math.max(0, Number(e.target.value) || 0))
						}
						className="w-32"
					/>
					<p className="text-[10px] text-muted-foreground">
						この日数より古い終了済みセッション (done / failed / aborted /
						escalated) をアプリ起動時に自動削除する。0
						で無効（手動削除のみ）。実行中・キュー中のセッションは対象外。
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>新規 TODO / スケジュールの既定値</Label>
					<AgentRuntimePicker
						agentKind={defaultAgentKind}
						onAgentKindChange={setDefaultAgentKind}
						claudeModel={defaultModel}
						claudeEffort={defaultEffort}
						onClaudeModelChange={setDefaultModel}
						onClaudeEffortChange={setDefaultEffort}
						codexModel={defaultCodexModel}
						codexEffort={defaultCodexEffort}
						onCodexModelChange={setDefaultCodexModel}
						onCodexEffortChange={setDefaultCodexEffort}
						crushModel={defaultCrushModel}
						onCrushModelChange={setDefaultCrushModel}
						crushModels={crushModelsData ?? []}
						compact={false}
					/>
					<p className="text-[10px] text-muted-foreground">
						新規に作る TODO
						やスケジュールのフォームに初期値として反映される。個別に上書き可。既存の
						TODO / スケジュールには影響しない。
					</p>
				</div>
				<div className="pt-2 border-t">
					<Button
						type="button"
						size="sm"
						onClick={handleSave}
						disabled={!dirty || updateMut.isPending}
					>
						保存
					</Button>
				</div>
			</div>
		</div>
	);
}

function PresetsTab({ open }: { open: boolean }) {
	const utils = electronTrpc.useUtils();
	const { data: presets } = electronTrpc.todoAgent.presets.list.useQuery(
		undefined,
		{ enabled: open },
	);

	const { data: projects } = electronTrpc.projects.getRecents.useQuery();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<{
		id: string | null;
		name: string;
		content: string;
		kind: PresetKind;
		workspaceId: string | null;
	}>({
		id: null,
		name: "",
		content: "",
		kind: "system",
		workspaceId: null,
	});
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	const createMut = electronTrpc.todoAgent.presets.create.useMutation();
	const updateMut = electronTrpc.todoAgent.presets.update.useMutation();
	const deleteMut = electronTrpc.todoAgent.presets.delete.useMutation();

	const invalidate = useCallback(
		() => utils.todoAgent.presets.list.invalidate(),
		[utils],
	);

	const selected = useMemo(
		() =>
			(presets ?? []).find(
				(p: SelectTodoPromptPreset) => p.id === selectedId,
			) ?? null,
		[presets, selectedId],
	);

	// Sync draft with selection changes.
	useEffect(() => {
		if (selected) {
			setDraft({
				id: selected.id,
				name: selected.name,
				content: selected.content,
				kind: selected.kind ?? "system",
				workspaceId: selected.workspaceId ?? null,
			});
		} else {
			setDraft({
				id: null,
				name: "",
				content: "",
				kind: "system",
				workspaceId: null,
			});
		}
		setConfirmingDelete(false);
	}, [selected]);

	const dirty =
		!!draft.name.trim() &&
		!!draft.content.trim() &&
		(!selected ||
			draft.name !== selected.name ||
			draft.content !== selected.content ||
			draft.kind !== (selected.kind ?? "system") ||
			draft.workspaceId !== (selected.workspaceId ?? null));

	const handleNew = useCallback(() => {
		setSelectedId(null);
		setDraft({
			id: null,
			name: "",
			content: "",
			kind: "system",
			workspaceId: null,
		});
	}, []);

	const handleSave = useCallback(async () => {
		try {
			if (draft.id) {
				const row = await updateMut.mutateAsync({
					id: draft.id,
					name: draft.name.trim(),
					content: draft.content.trim(),
					kind: draft.kind,
					workspaceId: draft.workspaceId,
				});
				setSelectedId(row.id);
				toast.success("テンプレートを更新しました");
			} else {
				const row = await createMut.mutateAsync({
					name: draft.name.trim(),
					content: draft.content.trim(),
					kind: draft.kind,
					workspaceId: draft.workspaceId ?? undefined,
				});
				setSelectedId(row.id);
				toast.success("テンプレートを作成しました");
			}
			await invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "保存に失敗しました",
			);
		}
	}, [createMut, draft, invalidate, updateMut]);

	const handleDelete = useCallback(async () => {
		if (!draft.id) return;
		try {
			await deleteMut.mutateAsync({ id: draft.id });
			await invalidate();
			setSelectedId(null);
			setConfirmingDelete(false);
			toast.success("テンプレートを削除しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "削除に失敗しました",
			);
		}
	}, [deleteMut, draft.id, invalidate]);

	return (
		<div className="flex flex-1 min-h-0">
			<div className="w-[260px] shrink-0 border-r flex flex-col min-h-0">
				<div className="p-2 border-b shrink-0">
					<Button
						type="button"
						size="sm"
						className="w-full h-8 text-xs rounded-md gap-1"
						onClick={handleNew}
					>
						<HiMiniPlus className="size-4" />
						新規テンプレート
					</Button>
				</div>
				<ScrollArea className="flex-1">
					<div className="flex flex-col p-1.5 gap-0.5">
						{(presets ?? []).length === 0 && (
							<p className="text-[11px] text-muted-foreground px-2 py-4">
								まだテンプレートはありません。右上から新規作成してください。
							</p>
						)}
						{(presets ?? []).map((preset: SelectTodoPromptPreset) => {
							const kind = preset.kind ?? "system";
							return (
								<button
									key={preset.id}
									type="button"
									onClick={() => setSelectedId(preset.id)}
									className={cn(
										"text-left rounded-md px-2.5 py-1.5 text-xs transition",
										selectedId === preset.id
											? "bg-accent"
											: "hover:bg-accent/50",
									)}
								>
									<div className="flex items-center gap-1.5">
										<span
											className={cn(
												"text-[9px] font-semibold px-1 py-0.5 rounded shrink-0",
												kind === "system" && "bg-primary/15 text-primary",
												kind === "description" &&
													"bg-amber-500/15 text-amber-600",
												kind === "goal" && "bg-emerald-500/15 text-emerald-600",
											)}
										>
											{KIND_LABEL[kind]}
										</span>
										<span className="font-medium line-clamp-1 flex-1 min-w-0">
											{preset.name}
										</span>
									</div>
									<div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
										{preset.content.replace(/\s+/g, " ")}
									</div>
								</button>
							);
						})}
					</div>
				</ScrollArea>
			</div>

			<div className="flex-1 min-w-0 flex flex-col p-5 gap-4 overflow-y-auto">
				<div className="grid grid-cols-2 gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="preset-kind">種別</Label>
						<select
							id="preset-kind"
							value={draft.kind}
							onChange={(e) =>
								setDraft((d) => ({
									...d,
									kind: e.target.value as PresetKind,
								}))
							}
							className="h-9 rounded-md border border-input bg-background px-2 text-xs"
						>
							<option value="system">システム（Claudeに常時渡される）</option>
							<option value="description">タスク（本文に挿入）</option>
							<option value="goal">ゴール（受け入れ条件に挿入）</option>
						</select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="preset-project">対象プロジェクト</Label>
						<select
							id="preset-project"
							value={draft.workspaceId ?? ""}
							onChange={(e) =>
								setDraft((d) => ({
									...d,
									workspaceId: e.target.value || null,
								}))
							}
							className="h-9 rounded-md border border-input bg-background px-2 text-xs"
						>
							<option value="">全プロジェクト（グローバル）</option>
							{(projects ?? []).map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</div>
				</div>
				<div className="flex flex-col gap-1.5">
					<label
						htmlFor="preset-name"
						className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold"
					>
						名前
					</label>
					<Input
						id="preset-name"
						value={draft.name}
						onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
						placeholder="例: 日本語で返答"
						maxLength={120}
						className="rounded-md"
					/>
				</div>
				<div className="flex flex-col gap-1.5 flex-1 min-h-0">
					<label
						htmlFor="preset-content"
						className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold"
					>
						内容（{KIND_LABEL[draft.kind]}テンプレート）
					</label>
					<Textarea
						id="preset-content"
						value={draft.content}
						onChange={(e) =>
							setDraft((d) => ({ ...d, content: e.target.value }))
						}
						placeholder="例: 回答は日本語で。コード内コメントは既存言語に合わせて。"
						className="flex-1 min-h-[200px] rounded-md font-mono text-xs leading-relaxed"
					/>
				</div>
				<div className="flex items-center justify-between gap-2 pt-2 border-t">
					<div>
						{draft.id &&
							(confirmingDelete ? (
								<div className="flex items-center gap-2">
									<Button
										type="button"
										size="sm"
										variant="destructive"
										onClick={handleDelete}
										disabled={deleteMut.isPending}
									>
										本当に削除
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => setConfirmingDelete(false)}
									>
										キャンセル
									</Button>
								</div>
							) : (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="gap-1 text-muted-foreground hover:text-destructive"
									onClick={() => setConfirmingDelete(true)}
								>
									<HiMiniTrash className="size-3.5" />
									削除
								</Button>
							))}
					</div>
					<Button
						type="button"
						size="sm"
						onClick={handleSave}
						disabled={!dirty || createMut.isPending || updateMut.isPending}
					>
						{draft.id ? "更新" : "作成"}
					</Button>
				</div>
			</div>
		</div>
	);
}
