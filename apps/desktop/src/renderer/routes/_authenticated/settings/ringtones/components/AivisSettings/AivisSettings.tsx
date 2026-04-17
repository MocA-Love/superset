import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
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

const PLACEHOLDERS = [
	{ key: "branch", label: "ブランチ" },
	{ key: "workspace", label: "ワークスペース" },
	{ key: "worktree", label: "ワークツリー" },
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
			</div>

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
