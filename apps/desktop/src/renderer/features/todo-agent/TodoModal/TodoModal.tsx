import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HiMiniSparkles, HiMiniXMark } from "react-icons/hi2";
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
} from "../ClaudeRuntimePicker";
import { EnhanceButton } from "./components/EnhanceButton";

interface TodoModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	projectId?: string;
}

const DEFAULT_VERIFY_COMMAND = "";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_MINUTES = 30;
const DEFAULT_CREATE_WORKTREE = false;

/**
 * Creation form for a new TODO autonomous session. Collects the minimum
 * needed for the supervisor to start a run: description, goal, verify
 * command, and budget. On submit, creates a DB row via trpc and closes.
 * The actual execution handoff (pane attach + start) is done separately
 * from the TodoPanel once the user opens it.
 */
export function TodoModal({
	open,
	onOpenChange,
	workspaceId,
	projectId,
}: TodoModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [goal, setGoal] = useState("");
	const [verifyCommand, setVerifyCommand] = useState(DEFAULT_VERIFY_COMMAND);
	const { data: todoSettings } = electronTrpc.todoAgent.settings.get.useQuery(
		undefined,
		{ enabled: open },
	);
	const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
	const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MINUTES);
	const [submitting, setSubmitting] = useState(false);
	const [createWorktree, setCreateWorktree] = useState(DEFAULT_CREATE_WORKTREE);
	const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
	const [claudeModel, setClaudeModel] =
		useState<ClaudeModelPick>(DEFAULT_SENTINEL);
	const [claudeEffort, setClaudeEffort] =
		useState<ClaudeEffortPick>(DEFAULT_SENTINEL);
	// Seed the picker from the global defaults only once per modal
	// opening. Without this guard, a React Query background refetch or
	// a settings update fired while the user is picking would overwrite
	// a deliberate "デフォルト" (DEFAULT_SENTINEL) selection — flipping
	// it back to the global default and silently changing what CLI flags
	// the next run gets.
	const seededRef = useRef(false);
	useEffect(() => {
		if (!open) {
			seededRef.current = false;
			return;
		}
		if (seededRef.current) return;
		// Wait until the settings query resolves so we actually have a
		// default to seed with. `todoSettings` is undefined on first
		// render; seeding too early would lock us into the sentinel.
		if (!todoSettings) return;
		setClaudeModel(fromPersistedModel(todoSettings.defaultClaudeModel ?? null));
		setClaudeEffort(
			fromPersistedEffort(todoSettings.defaultClaudeEffort ?? null),
		);
		seededRef.current = true;
	}, [open, todoSettings]);

	const utils = electronTrpc.useUtils();
	const create = electronTrpc.todoAgent.create.useMutation({
		onSuccess: async () => {
			await utils.todoAgent.list.invalidate({ workspaceId });
		},
	});
	const createWorkspaceMut = electronTrpc.workspaces.create.useMutation();
	const { data: presets } = electronTrpc.todoAgent.presets.list.useQuery(
		undefined,
		{
			enabled: open,
		},
	);
	const selectedPreset = useMemo(
		() => (presets ?? []).find((p) => p.id === selectedPresetId) ?? null,
		[presets, selectedPresetId],
	);

	const reset = useCallback(() => {
		setTitle("");
		setDescription("");
		setGoal("");
		setVerifyCommand(DEFAULT_VERIFY_COMMAND);
		setMaxIterations(
			todoSettings?.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS,
		);
		setMaxMinutes(todoSettings?.defaultMaxWallClockMin ?? DEFAULT_MAX_MINUTES);
		setCreateWorktree(DEFAULT_CREATE_WORKTREE);
		setSelectedPresetId(null);
		setClaudeModel(
			fromPersistedModel(todoSettings?.defaultClaudeModel ?? null),
		);
		setClaudeEffort(
			fromPersistedEffort(todoSettings?.defaultClaudeEffort ?? null),
		);
		setSubmitting(false);
	}, [todoSettings]);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) reset();
			onOpenChange(next);
		},
		[onOpenChange, reset],
	);

	const canUseNewWorktree = Boolean(projectId);
	const canSubmit =
		title.trim().length > 0 &&
		description.trim().length > 0 &&
		maxIterations >= 1 &&
		maxMinutes >= 1 &&
		!submitting &&
		(createWorktree ? canUseNewWorktree : workspaceId.length > 0);

	const hasVerify = verifyCommand.trim().length > 0;
	const hasGoal = goal.trim().length > 0;

	const handleSubmit = useCallback(async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			// Optionally create a dedicated worktree for this TODO first
			// so the worker runs in isolation. `workspaces.create` with a
			// `prompt` field auto-generates both the branch name and the
			// display name via the existing AI helpers
			// (ai-branch-name.ts / ai-name.ts), which reuse the same
			// `callSmallModel` path as the TODO text enhancer.
			let targetWorkspaceId = workspaceId;
			if (createWorktree) {
				if (!projectId) {
					throw new Error(
						"このワークスペースにはプロジェクトが紐付いていないので新しい worktree を作成できません",
					);
				}
				const namingPrompt = [title.trim(), description.trim()]
					.filter(Boolean)
					.join("\n\n");
				const result = await createWorkspaceMut.mutateAsync({
					projectId,
					prompt: namingPrompt || title.trim(),
				});
				targetWorkspaceId = result.workspace.id;
			}

			const created = await create.mutateAsync({
				workspaceId: targetWorkspaceId,
				projectId,
				title: title.trim(),
				description: description.trim(),
				goal: hasGoal ? goal.trim() : undefined,
				verifyCommand: hasVerify ? verifyCommand.trim() : undefined,
				maxIterations,
				maxWallClockSec: maxMinutes * 60,
				customSystemPrompt: selectedPreset?.content ?? undefined,
				claudeModel: toPersistedModel(claudeModel),
				claudeEffort: toPersistedEffort(claudeEffort),
			});
			if (createWorktree) {
				toast.success(
					"新しい worktree を作成して TODO セッションを紐付けました",
				);
			} else {
				toast.success("TODO セッションを作成しました");
			}
			handleOpenChange(false);
			void created;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "作成に失敗しました";
			toast.error(message);
			setSubmitting(false);
		}
	}, [
		hasGoal,
		hasVerify,
		canSubmit,
		claudeEffort,
		claudeModel,
		create,
		createWorkspaceMut,
		createWorktree,
		description,
		goal,
		handleOpenChange,
		maxIterations,
		maxMinutes,
		projectId,
		selectedPreset,
		title,
		verifyCommand,
		workspaceId,
	]);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-xl sm:max-w-xl rounded-xl">
				<DialogHeader>
					<DialogTitle>新しい自律 TODO</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-title">タイトル</Label>
						<Input
							id="todo-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="例: Issue #123 を修正"
							maxLength={200}
							autoFocus
							className="rounded-md"
						/>
					</div>

					<label
						htmlFor="todo-new-worktree"
						className={cn(
							"flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition",
							createWorktree
								? "border-primary/40 bg-primary/5"
								: "border-border/40 hover:bg-muted/40",
							!canUseNewWorktree && "opacity-60 cursor-not-allowed",
						)}
					>
						<Checkbox
							id="todo-new-worktree"
							checked={createWorktree}
							disabled={!canUseNewWorktree}
							onCheckedChange={(checked) => setCreateWorktree(checked === true)}
						/>
						<span className="text-xs font-medium flex-1">
							新しい worktree を作成して実行
						</span>
						<HiMiniSparkles className="size-3 text-primary/70" />
					</label>

					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="todo-description">やって欲しいこと</Label>
							<EnhanceButton
								value={description}
								onEnhanced={setDescription}
								kind="description"
							/>
						</div>
						<Textarea
							id="todo-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="やってほしい作業を書く"
							rows={4}
							className="rounded-md"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="todo-goal" className="flex items-center gap-1">
								ゴール
								<span className="text-muted-foreground font-normal text-[10px]">
									任意
								</span>
							</Label>
							<EnhanceButton value={goal} onEnhanced={setGoal} kind="goal" />
						</div>
						<Textarea
							id="todo-goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="完了条件（空欄可）"
							rows={2}
							className="rounded-md"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-verify" className="flex items-center gap-1">
							Verify
							<span className="text-muted-foreground font-normal text-[10px]">
								任意
							</span>
						</Label>
						<Input
							id="todo-verify"
							value={verifyCommand}
							onChange={(e) => setVerifyCommand(e.target.value)}
							placeholder="例: bun test"
							className="rounded-md"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label className="flex items-center gap-1">
							システムプロンプト
							<span className="text-muted-foreground font-normal text-[10px]">
								任意
							</span>
						</Label>
						<PresetPicker
							selected={selectedPreset}
							presets={presets ?? []}
							onSelect={setSelectedPresetId}
						/>
					</div>

					<ClaudeRuntimePicker
						model={claudeModel}
						effort={claudeEffort}
						onModelChange={setClaudeModel}
						onEffortChange={setClaudeEffort}
						disabled={submitting}
					/>

					{hasVerify && (
						<div className="grid grid-cols-2 gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-iter">最大イテレーション数</Label>
								<Input
									id="todo-iter"
									type="number"
									min={1}
									max={100}
									value={maxIterations}
									onChange={(e) =>
										setMaxIterations(Number(e.target.value) || 1)
									}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-minutes">壁時計上限（分）</Label>
								<Input
									id="todo-minutes"
									type="number"
									min={1}
									max={240}
									value={maxMinutes}
									onChange={(e) => setMaxMinutes(Number(e.target.value) || 1)}
								/>
							</div>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => handleOpenChange(false)}
						disabled={submitting}
					>
						キャンセル
					</Button>
					<Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
						{submitting ? "作成中…" : "作成"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface PresetPickerProps {
	selected: { id: string; name: string; content: string } | null;
	presets: Array<{ id: string; name: string; content: string }>;
	onSelect: (id: string | null) => void;
}

function PresetPicker({ selected, presets, onSelect }: PresetPickerProps) {
	const [open, setOpen] = useState(false);
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs transition",
						selected
							? "border-primary/40 bg-primary/5 text-foreground"
							: "border-border/40 text-muted-foreground hover:bg-muted/40",
					)}
				>
					<HiMiniSparkles className="size-3 text-primary/80" />
					<span className="flex-1 text-left truncate">
						{selected ? selected.name : "プリセットを選択（設定から管理）"}
					</span>
					{selected && (
						<button
							type="button"
							className="size-4 rounded-sm flex items-center justify-center hover:bg-background/80"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								onSelect(null);
							}}
							title="解除"
						>
							<HiMiniXMark className="size-3" />
						</button>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-[--radix-dropdown-menu-trigger-width] max-w-md"
			>
				<DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
					プリセット
				</DropdownMenuLabel>
				{presets.length === 0 ? (
					<DropdownMenuItem disabled>
						プリセットがありません。設定から作成してください。
					</DropdownMenuItem>
				) : (
					presets.map((preset) => (
						<DropdownMenuItem
							key={preset.id}
							onClick={() => {
								onSelect(preset.id);
								setOpen(false);
							}}
							className="flex flex-col items-start gap-0.5"
						>
							<span className="text-xs font-medium">{preset.name}</span>
							<span className="text-[10px] text-muted-foreground line-clamp-2">
								{preset.content}
							</span>
						</DropdownMenuItem>
					))
				)}
				{presets.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								onSelect(null);
								setOpen(false);
							}}
						>
							選択を解除
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
