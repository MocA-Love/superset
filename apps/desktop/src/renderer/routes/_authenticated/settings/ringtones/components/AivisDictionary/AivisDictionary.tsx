import { Button } from "@superset/ui/button";
import { useRef, useState } from "react";
import {
	HiArrowDownTray,
	HiArrowUpTray,
	HiCheck,
	HiPencil,
	HiPlus,
	HiTrash,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import { CreateDictionaryDialog } from "./CreateDictionaryDialog";
import { DictionaryEditorDialog } from "./DictionaryEditorDialog";

interface Props {
	visibleItems?: SettingItemId[] | null;
}

function formatDate(iso: string): string {
	return iso.slice(0, 10);
}

export function AivisDictionary({ visibleItems }: Props) {
	const visible = isItemVisible(
		SETTING_ITEM_ID.RINGTONES_AIVIS_DICTIONARY,
		visibleItems,
	);

	const utils = electronTrpc.useUtils();
	const { data: aivisSettings } =
		electronTrpc.settings.getAivisSettings.useQuery();
	const apiKey = aivisSettings?.apiKey ?? "";
	const activeUuid = aivisSettings?.userDictionaryUuid ?? "";

	const list = electronTrpc.aivis.dictionary.list.useQuery(undefined, {
		enabled: Boolean(apiKey),
		retry: false,
	});

	const saveSettings = electronTrpc.settings.setAivisSettings.useMutation({
		onSuccess: () => utils.settings.getAivisSettings.invalidate(),
	});
	const remove = electronTrpc.aivis.dictionary.delete.useMutation({
		onSuccess: () => utils.aivis.dictionary.list.invalidate(),
	});
	const importMutation = electronTrpc.aivis.dictionary.import.useMutation({
		onSuccess: () => utils.aivis.dictionary.list.invalidate(),
	});

	const [createOpen, setCreateOpen] = useState(false);
	const [editUuid, setEditUuid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [importTargetUuid, setImportTargetUuid] = useState<string | null>(null);

	if (!visible) return null;

	const handleSelectActive = (uuid: string) => {
		saveSettings.mutate({
			userDictionaryUuid: uuid === activeUuid ? "" : uuid,
		});
	};

	const handleDelete = (uuid: string, name: string) => {
		if (!confirm(`辞書「${name}」を削除します。よろしいですか？`)) return;
		remove.mutate({ uuid });
		if (uuid === activeUuid) saveSettings.mutate({ userDictionaryUuid: "" });
	};

	const handleExport = async (uuid: string, name: string) => {
		try {
			setError(null);
			const data = await electronTrpcClient.aivis.dictionary.export.query({
				uuid,
			});
			const blob = new Blob([JSON.stringify(data, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${name || "dictionary"}.aivisspeech.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const triggerImport = (uuid: string) => {
		setImportTargetUuid(uuid);
		fileInputRef.current?.click();
	};

	const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file || !importTargetUuid) return;
		try {
			setError(null);
			const text = await file.text();
			const data = JSON.parse(text);
			if (typeof data !== "object" || Array.isArray(data) || data === null) {
				throw new Error(
					"AivisSpeech 互換の JSON オブジェクトを選択してください",
				);
			}
			await importMutation.mutateAsync({
				uuid: importTargetUuid,
				data,
				override: false,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportTargetUuid(null);
		}
	};

	return (
		<div className="pt-6 border-t space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-base font-semibold">ユーザー辞書</h3>
					<p className="text-sm text-muted-foreground mt-1">
						固有名詞・英略語・ブランチ名など特殊な読み方をする単語を登録します。
						AivisSpeech 互換 JSON の import / export に対応。
					</p>
				</div>
				<div className="shrink-0 flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setCreateOpen(true)}
						disabled={!apiKey}
					>
						<HiPlus className="mr-1.5 h-3.5 w-3.5" />
						新規辞書
					</Button>
				</div>
			</div>

			{!apiKey && (
				<div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
					Aivis API キーを設定すると辞書を管理できます。
				</div>
			)}

			{apiKey && list.isLoading && (
				<div className="text-sm text-muted-foreground">読み込み中…</div>
			)}

			{apiKey && list.error && (
				<div className="text-sm text-destructive">
					辞書の取得に失敗しました: {list.error.message}
				</div>
			)}

			{apiKey && list.data && list.data.length === 0 && (
				<div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
					まだ辞書がありません。「新規辞書」から作成してください。
				</div>
			)}

			<div className="space-y-2">
				{list.data?.map((d) => {
					const isActive = d.uuid === activeUuid;
					return (
						<div
							key={d.uuid}
							className={`rounded-lg border p-4 ${
								isActive ? "border-emerald-500/40 bg-emerald-500/5" : "bg-card"
							}`}
						>
							<div className="flex items-center justify-between gap-3">
								<div className="flex items-center gap-3 min-w-0">
									<span
										className={`h-2 w-2 rounded-full ${
											isActive ? "bg-emerald-400" : "bg-muted-foreground/30"
										}`}
									/>
									<div className="min-w-0">
										<div className="text-sm font-medium flex items-center gap-2">
											<span className="truncate">{d.name}</span>
											{isActive && (
												<span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-500">
													ACTIVE
												</span>
											)}
										</div>
										<div className="text-xs text-muted-foreground mt-0.5 truncate">
											{d.description || "—"} · {d.word_count} words · Updated{" "}
											{formatDate(d.updated_at)}
										</div>
									</div>
								</div>
								<div className="flex items-center gap-1.5 shrink-0">
									{!isActive && (
										<Button
											size="sm"
											variant="outline"
											onClick={() => handleSelectActive(d.uuid)}
											disabled={saveSettings.isPending}
										>
											<HiCheck className="mr-1 h-3.5 w-3.5" />
											適用
										</Button>
									)}
									<Button
										size="sm"
										variant="outline"
										onClick={() => setEditUuid(d.uuid)}
									>
										<HiPencil className="mr-1 h-3.5 w-3.5" />
										編集
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => triggerImport(d.uuid)}
										disabled={importMutation.isPending}
										title="AivisSpeech JSON を取り込み"
									>
										<HiArrowUpTray className="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => handleExport(d.uuid, d.name)}
										title="AivisSpeech JSON をエクスポート"
									>
										<HiArrowDownTray className="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => handleDelete(d.uuid, d.name)}
										disabled={remove.isPending}
										className="hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40"
									>
										<HiTrash className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<input
				ref={fileInputRef}
				type="file"
				accept="application/json,.json"
				className="hidden"
				onChange={handleImportFile}
			/>

			<CreateDictionaryDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={(uuid) => setEditUuid(uuid)}
			/>

			<DictionaryEditorDialog
				uuid={editUuid}
				open={Boolean(editUuid)}
				onOpenChange={(open) => !open && setEditUuid(null)}
			/>
		</div>
	);
}
