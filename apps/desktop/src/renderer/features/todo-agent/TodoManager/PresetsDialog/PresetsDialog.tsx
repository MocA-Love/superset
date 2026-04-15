import type { SelectTodoPromptPreset } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
export function PresetsDialog({ open, onOpenChange }: PresetsDialogProps) {
	const utils = electronTrpc.useUtils();
	const { data: presets } = electronTrpc.todoAgent.presets.list.useQuery(
		undefined,
		{ enabled: open },
	);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<{
		id: string | null;
		name: string;
		content: string;
	}>({ id: null, name: "", content: "" });
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
			});
		} else {
			setDraft({ id: null, name: "", content: "" });
		}
		setConfirmingDelete(false);
	}, [selected]);

	const dirty =
		!!draft.name.trim() &&
		!!draft.content.trim() &&
		(!selected ||
			draft.name !== selected.name ||
			draft.content !== selected.content);

	const handleNew = useCallback(() => {
		setSelectedId(null);
		setDraft({ id: null, name: "", content: "" });
	}, []);

	const handleSave = useCallback(async () => {
		try {
			if (draft.id) {
				const row = await updateMut.mutateAsync({
					id: draft.id,
					name: draft.name.trim(),
					content: draft.content.trim(),
				});
				setSelectedId(row.id);
				toast.success("プリセットを更新しました");
			} else {
				const row = await createMut.mutateAsync({
					name: draft.name.trim(),
					content: draft.content.trim(),
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
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[960px] max-w-[calc(100vw-4rem)] sm:max-w-[calc(100vw-4rem)] h-[80vh] max-h-[840px] p-0 gap-0 overflow-hidden flex flex-col rounded-xl"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">
					システムプロンプトテンプレート
				</DialogTitle>
				<div className="shrink-0 border-b h-12 flex items-center justify-between px-4">
					<div className="flex items-center gap-3">
						<span className="text-sm font-semibold">
							システムプロンプトテンプレート
						</span>
						<span className="text-xs text-muted-foreground">
							TODO に付けられる再利用プロンプト
						</span>
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
								{(presets ?? []).map(
									(preset: SelectTodoPromptPreset) => (
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
											<div className="font-medium line-clamp-1">
												{preset.name}
											</div>
											<div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
												{preset.content.replace(/\s+/g, " ")}
											</div>
										</button>
									),
								)}
							</div>
						</ScrollArea>
					</div>

					<div className="flex-1 min-w-0 flex flex-col p-5 gap-4 overflow-y-auto">
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
								onChange={(e) =>
									setDraft((d) => ({ ...d, name: e.target.value }))
								}
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
								システムプロンプト
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
								disabled={
									!dirty || createMut.isPending || updateMut.isPending
								}
							>
								{draft.id ? "更新" : "作成"}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
