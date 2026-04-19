import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { HiPlay } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import { AivisSpeakingRateSlider } from "./components/AivisSpeakingRateSlider";
import { AivisVolumeSlider } from "./components/AivisVolumeSlider";
import { ModelPresetTiles } from "./components/ModelPresetTiles";

const PLACEHOLDERS = [
	{ key: "branch", label: "ブランチ" },
	{ key: "workspace", label: "ワークスペース" },
	{ key: "worktree", label: "ワークツリー" },
	{ key: "project", label: "プロジェクト" },
	{ key: "tab", label: "タブ" },
	{ key: "pane", label: "ペーン" },
	{ key: "event", label: "イベント" },
] as const;

interface AivisSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function AivisSettings({ visibleItems }: AivisSettingsProps) {
	const visible = isItemVisible(SETTING_ITEM_ID.RINGTONES_AIVIS, visibleItems);

	const utils = electronTrpc.useUtils();
	const { data } = electronTrpc.settings.getAivisSettings.useQuery();
	const save = electronTrpc.settings.setAivisSettings.useMutation({
		onSuccess: () => utils.settings.getAivisSettings.invalidate(),
	});
	const testPlay = electronTrpc.settings.testAivisPlayback.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [modelUuid, setModelUuid] = useState("");
	const [format, setFormat] = useState("");
	const [formatPermission, setFormatPermission] = useState("");
	const [testError, setTestError] = useState<string | null>(null);

	const formatRef = useRef<HTMLTextAreaElement | null>(null);
	const formatPermissionRef = useRef<HTMLTextAreaElement | null>(null);
	const [activeField, setActiveField] = useState<"format" | "permission">(
		"format",
	);
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (!data || hydratedRef.current) return;
		hydratedRef.current = true;
		setEnabled(data.enabled);
		setApiKey(data.apiKey);
		setModelUuid(data.modelUuid);
		setFormat(data.format);
		setFormatPermission(data.formatPermission);
	}, [data]);

	if (!visible) return null;

	const insertPlaceholder = (key: string) => {
		const ref = activeField === "permission" ? formatPermissionRef : formatRef;
		const setter =
			activeField === "permission" ? setFormatPermission : setFormat;
		const current = activeField === "permission" ? formatPermission : format;
		const token = `{{${key}}}`;
		const el = ref.current;
		if (!el) {
			setter(current + token);
			return;
		}
		const start = el.selectionStart ?? current.length;
		const end = el.selectionEnd ?? current.length;
		const next = current.slice(0, start) + token + current.slice(end);
		setter(next);
		requestAnimationFrame(() => {
			el.focus();
			const pos = start + token.length;
			el.setSelectionRange(pos, pos);
		});
	};

	const handleToggle = (next: boolean) => {
		setEnabled(next);
		save.mutate({ enabled: next });
	};

	const commit = (patch: Parameters<typeof save.mutate>[0]) => {
		save.mutate(patch);
	};

	const handleTest = async (kind: "complete" | "permission") => {
		setTestError(null);
		const template = kind === "permission" ? formatPermission : format;
		const rendered = template
			.replace(/\{\{\s*branch\s*\}\}/g, "サンプルブランチ")
			.replace(/\{\{\s*workspace\s*\}\}/g, "サンプルワークスペース")
			.replace(/\{\{\s*worktree\s*\}\}/g, "サンプルワークツリー")
			.replace(/\{\{\s*project\s*\}\}/g, "サンプルプロジェクト")
			.replace(/\{\{\s*tab\s*\}\}/g, "ターミナル")
			.replace(/\{\{\s*pane\s*\}\}/g, "ペーン1")
			.replace(
				/\{\{\s*event\s*\}\}/g,
				kind === "permission" ? "PermissionRequest" : "Stop",
			)
			.replace(/\{\{\s*\w+\s*\}\}/g, "");
		try {
			await testPlay.mutateAsync({
				apiKey,
				modelUuid,
				text: rendered || "テストです",
				speakingRate: data?.speakingRate,
			});
		} catch (err) {
			setTestError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div className="pt-6 border-t space-y-6">
			<div>
				<h3 className="text-base font-semibold">Aivis Voice Announcement</h3>
				<p className="text-sm text-muted-foreground mt-1">
					通知音の後に Aivis API
					でワークスペース名やブランチ名を音声で読み上げます。
				</p>
			</div>

			<div className="flex items-center justify-between">
				<div>
					<Label>音声報告を有効化</Label>
					<p className="text-xs text-muted-foreground mt-1">
						LLM の動作完了時と許可要求時に音声で通知します。
					</p>
				</div>
				<Switch checked={enabled} onCheckedChange={handleToggle} />
			</div>

			{enabled && <AivisVolumeSlider disabled={!enabled} />}
			{enabled && <AivisSpeakingRateSlider disabled={!enabled} />}

			<div className="space-y-2">
				<Label htmlFor="aivis-api-key">API Key</Label>
				<Input
					id="aivis-api-key"
					type="password"
					autoComplete="off"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					onBlur={() => commit({ apiKey })}
					placeholder="aivis_..."
					disabled={!enabled}
				/>
			</div>

			<ModelPresetTiles
				currentModelUuid={modelUuid}
				disabled={!enabled}
				onSelect={(uuid) => {
					setModelUuid(uuid);
					commit({ modelUuid: uuid });
				}}
			/>

			<div className="space-y-2">
				<Label htmlFor="aivis-model-uuid">Model UUID</Label>
				<Input
					id="aivis-model-uuid"
					value={modelUuid}
					onChange={(e) => setModelUuid(e.target.value)}
					onBlur={() => commit({ modelUuid })}
					placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
					disabled={!enabled}
				/>
				<SelectedModelInfo uuid={modelUuid} />
			</div>

			<AivisDictionarySelector apiKey={apiKey} enabled={enabled} />

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>プレースホルダ</Label>
					<span className="text-xs text-muted-foreground">
						{activeField === "permission"
							? "許可要求フォーマットに挿入"
							: "完了フォーマットに挿入"}
					</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{PLACEHOLDERS.map((p) => (
						<Button
							key={p.key}
							type="button"
							size="sm"
							variant="outline"
							disabled={!enabled}
							onClick={() => insertPlaceholder(p.key)}
						>
							{`{{${p.key}}}`}
							<span className="ml-1 text-muted-foreground">/ {p.label}</span>
						</Button>
					))}
				</div>
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label htmlFor="aivis-format">完了フォーマット</Label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={!enabled || !apiKey || !modelUuid || testPlay.isPending}
						onClick={() => handleTest("complete")}
					>
						<HiPlay className="mr-1.5 h-3.5 w-3.5" />
						テスト再生
					</Button>
				</div>
				<Textarea
					id="aivis-format"
					ref={formatRef}
					rows={2}
					value={format}
					onChange={(e) => setFormat(e.target.value)}
					onFocus={() => setActiveField("format")}
					onBlur={() => commit({ format })}
					placeholder="ワークスペース、{{workspace}}、です"
					disabled={!enabled}
				/>
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label htmlFor="aivis-format-permission">許可要求フォーマット</Label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={!enabled || !apiKey || !modelUuid || testPlay.isPending}
						onClick={() => handleTest("permission")}
					>
						<HiPlay className="mr-1.5 h-3.5 w-3.5" />
						テスト再生
					</Button>
				</div>
				<Textarea
					id="aivis-format-permission"
					ref={formatPermissionRef}
					rows={2}
					value={formatPermission}
					onChange={(e) => setFormatPermission(e.target.value)}
					onFocus={() => setActiveField("permission")}
					onBlur={() => commit({ formatPermission })}
					placeholder="{{branch}}で対応が必要です"
					disabled={!enabled}
				/>
			</div>

			{testError && <p className="text-sm text-destructive">{testError}</p>}
		</div>
	);
}

function AivisDictionarySelector({
	apiKey,
	enabled,
}: {
	apiKey: string;
	enabled: boolean;
}) {
	const utils = electronTrpc.useUtils();
	const { data: settingsData } =
		electronTrpc.settings.getAivisSettings.useQuery();
	const list = electronTrpc.aivis.dictionary.list.useQuery(undefined, {
		enabled: Boolean(apiKey),
		retry: false,
	});
	const save = electronTrpc.settings.setAivisSettings.useMutation({
		onSuccess: () => utils.settings.getAivisSettings.invalidate(),
	});

	const selected = settingsData?.userDictionaryUuid || "__none__";

	const options = list.data ?? [];

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label>適用するユーザー辞書</Label>
				{list.error && (
					<span className="text-xs text-muted-foreground">
						辞書の取得に失敗
					</span>
				)}
			</div>
			<Select
				value={selected}
				onValueChange={(v) =>
					save.mutate({ userDictionaryUuid: v === "__none__" ? "" : v })
				}
				disabled={!enabled || !apiKey || list.isLoading}
			>
				<SelectTrigger>
					<SelectValue placeholder="— 辞書なし —" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__none__">— 辞書なし —</SelectItem>
					{options.map((d) => (
						<SelectItem key={d.uuid} value={d.uuid}>
							{d.name} ({d.word_count} 語)
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-[11px] text-muted-foreground">
				下の「ユーザー辞書」セクションで辞書の作成・編集ができます。
			</p>
		</div>
	);
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SelectedModelInfo({ uuid }: { uuid: string }) {
	const trimmed = uuid.trim();
	const isValid = UUID_RE.test(trimmed);
	const model = electronTrpc.aivis.model.get.useQuery(
		{ uuid: trimmed },
		{ enabled: isValid, retry: false, staleTime: 60 * 60 * 1000 },
	);

	if (!trimmed) return null;
	if (!isValid) {
		return (
			<p className="text-[11px] text-muted-foreground">
				UUID 形式 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) で入力してください。
			</p>
		);
	}
	if (model.isLoading) {
		return (
			<p className="text-[11px] text-muted-foreground">モデル情報を取得中…</p>
		);
	}
	if (model.error) {
		return (
			<p className="text-[11px] text-destructive truncate">
				モデル取得失敗: {model.error.message}
			</p>
		);
	}
	if (!model.data) return null;
	return (
		<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
			{model.data.iconUrl ? (
				<img
					src={model.data.iconUrl}
					alt=""
					className="h-5 w-5 rounded object-cover"
				/>
			) : (
				<span className="h-5 w-5 rounded bg-muted flex items-center justify-center">
					🎙️
				</span>
			)}
			<span>
				選択中: <span className="text-foreground">{model.data.name}</span>
				{model.data.authorName ? ` / by ${model.data.authorName}` : ""}
			</span>
		</div>
	);
}
