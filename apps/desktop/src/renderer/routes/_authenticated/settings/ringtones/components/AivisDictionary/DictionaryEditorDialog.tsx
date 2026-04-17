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
import { useEffect, useState } from "react";
import { HiPlus, HiXMark } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

const WORD_TYPES = [
	{ value: "PROPER_NOUN", label: "固有名詞" },
	{ value: "COMMON_NOUN", label: "一般名詞" },
	{ value: "VERB", label: "動詞" },
	{ value: "ADJECTIVE", label: "形容詞" },
	{ value: "SUFFIX", label: "接尾辞" },
] as const;

type WordType = (typeof WORD_TYPES)[number]["value"];

interface WordRow {
	uuid: string;
	surface: string;
	pronunciation: string;
	accentType: number;
	wordType: WordType;
	priority: number;
}

interface Props {
	uuid: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const KATAKANA_RE = /^[\u30A0-\u30FFー\s]+$/;

export function DictionaryEditorDialog({ uuid, open, onOpenChange }: Props) {
	const utils = electronTrpc.useUtils();
	const detail = electronTrpc.aivis.dictionary.get.useQuery(
		{ uuid: uuid ?? "" },
		{ enabled: Boolean(uuid) && open, staleTime: 0 },
	);
	const update = electronTrpc.aivis.dictionary.update.useMutation({
		onSuccess: async () => {
			await utils.aivis.dictionary.list.invalidate();
			if (uuid) await utils.aivis.dictionary.get.invalidate({ uuid });
			onOpenChange(false);
		},
	});

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [words, setWords] = useState<WordRow[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!detail.data) return;
		setName(detail.data.name);
		setDescription(detail.data.description);
		setWords(
			detail.data.word_properties.map((w) => ({
				uuid: w.uuid,
				surface: w.surface[0] ?? "",
				pronunciation: w.pronunciation[0] ?? "",
				accentType: w.accent_type[0] ?? 0,
				wordType: w.word_type,
				priority: w.priority,
			})),
		);
		setError(null);
	}, [detail.data]);

	const addRow = () => {
		setWords((rows) => [
			...rows,
			{
				uuid: crypto.randomUUID(),
				surface: "",
				pronunciation: "",
				accentType: 0,
				wordType: "PROPER_NOUN",
				priority: 5,
			},
		]);
	};

	const patchRow = (idx: number, patch: Partial<WordRow>) => {
		setWords((rows) =>
			rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
		);
	};

	const removeRow = (idx: number) => {
		setWords((rows) => rows.filter((_, i) => i !== idx));
	};

	const handleSave = () => {
		setError(null);
		if (!uuid) return;
		if (!name.trim()) {
			setError("辞書名を入力してください");
			return;
		}
		for (const [i, w] of words.entries()) {
			if (!w.surface.trim()) {
				setError(`行 ${i + 1}: 表記が空です`);
				return;
			}
			if (!w.pronunciation.trim()) {
				setError(`行 ${i + 1}: 読みが空です`);
				return;
			}
			if (!KATAKANA_RE.test(w.pronunciation.trim())) {
				setError(`行 ${i + 1}: 読みはカタカナで入力してください`);
				return;
			}
		}
		update.mutate({
			uuid,
			name: name.trim(),
			description: description.trim(),
			words: words.map((w) => ({
				uuid: w.uuid,
				surface: [w.surface.trim()],
				pronunciation: [w.pronunciation.trim()],
				accent_type: [Math.max(0, Math.floor(w.accentType))],
				word_type: w.wordType,
				priority: Math.max(0, Math.min(10, Math.floor(w.priority))),
			})),
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="!max-w-[900px] sm:!max-w-[900px]">
				<DialogHeader>
					<DialogTitle>ユーザー辞書を編集</DialogTitle>
					<DialogDescription>
						Aivis
						の音声合成時に適用される読み方を登録します。読みはカタカナで入力してください。
					</DialogDescription>
				</DialogHeader>

				{detail.isLoading ? (
					<div className="py-12 text-center text-sm text-muted-foreground">
						読み込み中…
					</div>
				) : detail.error ? (
					<div className="py-8 text-sm text-destructive">
						読み込みに失敗しました: {detail.error.message}
					</div>
				) : (
					<div className="space-y-4">
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="dict-name">名前</Label>
								<Input
									id="dict-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									maxLength={100}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="dict-desc">説明</Label>
								<Input
									id="dict-desc"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									maxLength={500}
								/>
							</div>
						</div>

						<div className="rounded-md border overflow-hidden">
							<div className="grid grid-cols-[24%_26%_12%_14%_18%_auto] bg-muted text-xs font-medium text-muted-foreground px-3 py-2">
								<div>表記</div>
								<div>読み (カタカナ)</div>
								<div>アクセント</div>
								<div>優先度 (0-10)</div>
								<div>品詞</div>
								<div />
							</div>
							<div className="max-h-[360px] overflow-y-auto divide-y">
								{words.length === 0 && (
									<div className="px-3 py-6 text-center text-xs text-muted-foreground">
										まだ単語がありません。右下の「行を追加」から開始してください。
									</div>
								)}
								{words.map((w, i) => (
									<div
										key={w.uuid}
										className="grid grid-cols-[24%_26%_12%_14%_18%_auto] items-center px-3 py-1.5 gap-2 text-xs"
									>
										<Input
											className="h-7 text-xs font-mono"
											value={w.surface}
											onChange={(e) => patchRow(i, { surface: e.target.value })}
											placeholder="Superset"
										/>
										<Input
											className="h-7 text-xs font-mono"
											value={w.pronunciation}
											onChange={(e) =>
												patchRow(i, { pronunciation: e.target.value })
											}
											placeholder="スーパーセット"
										/>
										<Input
											className="h-7 text-xs tabular-nums"
											type="number"
											min={0}
											value={w.accentType}
											onChange={(e) =>
												patchRow(i, {
													accentType: Number(e.target.value) || 0,
												})
											}
										/>
										<Input
											className="h-7 text-xs tabular-nums"
											type="number"
											min={0}
											max={10}
											value={w.priority}
											onChange={(e) =>
												patchRow(i, { priority: Number(e.target.value) || 0 })
											}
										/>
										<Select
											value={w.wordType}
											onValueChange={(v) =>
												patchRow(i, { wordType: v as WordType })
											}
										>
											<SelectTrigger className="h-7 text-xs">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{WORD_TYPES.map((t) => (
													<SelectItem key={t.value} value={t.value}>
														{t.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<button
											type="button"
											onClick={() => removeRow(i)}
											className="p-1 text-muted-foreground hover:text-destructive"
											aria-label="削除"
										>
											<HiXMark className="h-4 w-4" />
										</button>
									</div>
								))}
							</div>
						</div>

						<div className="flex items-center justify-between">
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={addRow}
							>
								<HiPlus className="mr-1.5 h-3.5 w-3.5" />
								行を追加
							</Button>
							<p className="text-[11px] text-muted-foreground">
								アクセント核は 0 始まりの整数 (0 = 平板型)。
							</p>
						</div>

						{error && <p className="text-sm text-destructive">{error}</p>}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={update.isPending}
					>
						キャンセル
					</Button>
					<Button
						type="button"
						onClick={handleSave}
						disabled={update.isPending || detail.isLoading || !uuid}
					>
						{update.isPending ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
