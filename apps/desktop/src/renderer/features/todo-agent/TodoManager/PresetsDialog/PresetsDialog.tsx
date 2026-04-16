import type { SelectTodoPromptPreset } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	HiMiniCog6Tooth,
	HiMiniPlus,
	HiMiniTrash,
	HiMiniXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface PresetsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Manager for reusable TODO system-prompt templates. Entered from the
 * "設定" row at the bottom of the Agent Manager's left sidebar.
 * Two-pane layout: list of presets on the left, edit form on the right.
 */
type Tab = "presets" | "settings";

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
							プリセット
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

	const [maxIter, setMaxIter] = useState(10);
	const [maxMin, setMaxMin] = useState(30);
	const [maxConcurrent, setMaxConcurrent] = useState(1);

	useEffect(() => {
		if (settings) {
			setMaxIter(settings.defaultMaxIterations);
			setMaxMin(settings.defaultMaxWallClockMin);
			setMaxConcurrent(settings.maxConcurrentTasks);
		}
	}, [settings]);

	const dirty =
		settings != null &&
		(maxIter !== settings.defaultMaxIterations ||
			maxMin !== settings.defaultMaxWallClockMin ||
			maxConcurrent !== settings.maxConcurrentTasks);

	const handleSave = useCallback(async () => {
		try {
			await updateMut.mutateAsync({
				defaultMaxIterations: maxIter,
				defaultMaxWallClockMin: maxMin,
				maxConcurrentTasks: maxConcurrent,
			});
			await utils.todoAgent.settings.get.invalidate();
			toast.success("設定を保存しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "保存に失敗しました",
			);
		}
	}, [maxIter, maxMin, maxConcurrent, updateMut, utils]);

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

	type PresetKind = "system" | "description" | "goal";
	const KIND_LABEL: Record<PresetKind, string> = {
		system: "システムプロンプト",
		description: "やって欲しいこと",
		goal: "ゴール",
	};

	const { data: projects } = electronTrpc.projects.getRecents.useQuery();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<{
		id: string | null;
		name: string;
		content: string;
		kind: PresetKind;
		workspaceId: string | null;
	}>({ id: null, name: "", content: "", kind: "system", workspaceId: null });
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

	// Group presets by workspace (null = global), then by kind within each group
	const groupedPresets = useMemo(() => {
		const all = presets ?? [];
		const byWorkspace = new Map<string | null, SelectTodoPromptPreset[]>();
		for (const p of all) {
			const key = p.workspaceId ?? null;
			const arr = byWorkspace.get(key) ?? [];
			arr.push(p);
			byWorkspace.set(key, arr);
		}
		const workspaceName = (id: string | null) => {
			if (id == null) return "グローバル";
			// `workspaceId` on presets is repurposed to mean projectId so
			// we only show project-level groups (not every worktree).
			return (
				(projects ?? []).find((p) => p.id === id)?.name ??
				`project ${id.slice(0, 6)}`
			);
		};
		return Array.from(byWorkspace.entries())
			.sort(([a], [b]) => {
				if (a === null) return -1;
				if (b === null) return 1;
				return 0;
			})
			.map(([wsId, list]) => ({
				workspaceId: wsId,
				label: workspaceName(wsId),
				items: list,
			}));
	}, [presets, projects]);

	// Sync draft with selection changes.
	useEffect(() => {
		if (selected) {
			setDraft({
				id: selected.id,
				name: selected.name,
				content: selected.content,
				kind:
					(selected as SelectTodoPromptPreset & { kind?: PresetKind }).kind ??
					"system",
				workspaceId:
					(selected as SelectTodoPromptPreset & { workspaceId?: string | null })
						.workspaceId ?? null,
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
			draft.kind !==
				((selected as SelectTodoPromptPreset & { kind?: PresetKind }).kind ??
					"system") ||
			draft.workspaceId !==
				((selected as SelectTodoPromptPreset & { workspaceId?: string | null })
					.workspaceId ?? null));

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
				toast.success("プリセットを更新しました");
			} else {
				const row = await createMut.mutateAsync({
					name: draft.name.trim(),
					content: draft.content.trim(),
					kind: draft.kind,
					workspaceId: draft.workspaceId ?? undefined,
				});
				setSelectedId(row.id);
				toast.success("プリセットを作成しました");
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
			toast.success("プリセットを削除しました");
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
						新規プリセット
					</Button>
				</div>
				<ScrollArea className="flex-1">
					<div className="flex flex-col p-1.5 gap-0.5">
						{(presets ?? []).length === 0 && (
							<p className="text-[11px] text-muted-foreground px-2 py-4">
								まだプリセットはありません。右上から新規作成してください。
							</p>
						)}
						{groupedPresets.map((group) => (
							<div key={group.workspaceId ?? "global"} className="mb-2">
								<div className="sticky top-0 z-10 bg-background/95 backdrop-blur text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-2 py-1 border-b">
									📁 {group.label}
									<span className="ml-1 text-muted-foreground/60 normal-case tracking-normal">
										({group.items.length})
									</span>
								</div>
								{group.items.map((preset: SelectTodoPromptPreset) => {
									const kind =
										(preset as SelectTodoPromptPreset & { kind?: PresetKind })
											.kind ?? "system";
									return (
										<button
											key={preset.id}
											type="button"
											onClick={() => setSelectedId(preset.id)}
											className={cn(
												"text-left rounded-md px-2.5 py-1.5 text-xs transition w-full",
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
														kind === "goal" &&
															"bg-emerald-500/15 text-emerald-600",
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
						))}
					</div>
				</ScrollArea>
			</div>

			<div className="flex-1 min-w-0 flex flex-col p-5 gap-4 overflow-y-auto">
				<div className="grid grid-cols-2 gap-3">
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor="preset-kind"
							className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold"
						>
							種別
						</Label>
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
							<option value="system">
								システムプロンプト（Claudeに常時渡す）
							</option>
							<option value="description">
								やって欲しいこと（本文テンプレ）
							</option>
							<option value="goal">ゴール（受け入れ条件テンプレ）</option>
						</select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor="preset-workspace"
							className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold"
						>
							対象プロジェクト
						</Label>
						<select
							id="preset-workspace"
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
						内容（{KIND_LABEL[draft.kind]}）
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
