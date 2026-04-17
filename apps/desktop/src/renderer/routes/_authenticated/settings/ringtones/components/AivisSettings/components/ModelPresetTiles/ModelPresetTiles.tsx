import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import { HiPlus, HiXMark } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AddModelPresetDialog } from "../AddModelPresetDialog";

const DEFAULT_PRESET_NAMES = [
	"まい",
	"花音",
	"るな",
	"桜音",
	"中2",
	"zonoko",
	"コハク",
	"まお",
	"天深シノ",
] as const;

interface PresetItem {
	uuid: string;
	name: string;
	iconUrl: string | null;
	source: "default" | "custom";
}

interface Props {
	currentModelUuid: string;
	disabled?: boolean;
	onSelect: (uuid: string) => void;
}

export function ModelPresetTiles({
	currentModelUuid,
	disabled,
	onSelect,
}: Props) {
	const utils = electronTrpc.useUtils();
	const { data: settingsData } =
		electronTrpc.settings.getAivisSettings.useQuery();
	const save = electronTrpc.settings.setAivisSettings.useMutation({
		onSuccess: () => utils.settings.getAivisSettings.invalidate(),
	});

	const [addOpen, setAddOpen] = useState(false);

	const customPresets = settingsData?.modelPresets ?? [];

	// Resolve all default preset names via a single batched query.
	const defaultPresets = electronTrpc.aivis.model.resolveByNames.useQuery(
		{ names: [...DEFAULT_PRESET_NAMES] },
		{ retry: false, staleTime: 60 * 60 * 1000 },
	);

	const items: PresetItem[] = useMemo(() => {
		const seen = new Set<string>();
		const out: PresetItem[] = [];
		for (const r of defaultPresets.data ?? []) {
			if (!r.model || seen.has(r.model.uuid)) continue;
			seen.add(r.model.uuid);
			out.push({
				uuid: r.model.uuid,
				name: r.model.name,
				iconUrl: r.model.iconUrl,
				source: "default",
			});
		}
		for (const p of customPresets) {
			if (seen.has(p.uuid)) continue;
			seen.add(p.uuid);
			out.push({ ...p, source: "custom" });
		}
		return out;
	}, [defaultPresets.data, customPresets]);

	const removeCustom = (uuid: string) => {
		const next = customPresets.filter((p) => p.uuid !== uuid);
		save.mutate({ modelPresets: next });
		if (currentModelUuid === uuid) save.mutate({ modelUuid: "" });
	};

	const addCustom = (preset: {
		uuid: string;
		name: string;
		iconUrl: string | null;
	}) => {
		const exists = customPresets.some((p) => p.uuid === preset.uuid);
		const next = exists ? customPresets : [...customPresets, preset];
		save.mutate({ modelPresets: next });
		onSelect(preset.uuid);
	};

	const anyDefaultLoading = defaultPresets.isLoading;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<div className="text-sm font-medium">モデル</div>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => setAddOpen(true)}
					disabled={disabled}
				>
					<HiPlus className="mr-1.5 h-3.5 w-3.5" />
					追加
				</Button>
			</div>

			{anyDefaultLoading && items.length === 0 && (
				<div className="text-xs text-muted-foreground">
					モデル一覧を読み込み中…
				</div>
			)}

			<div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
				{items.map((item) => {
					const selected = currentModelUuid === item.uuid;
					return (
						<button
							key={item.uuid}
							type="button"
							onClick={() => onSelect(item.uuid)}
							disabled={disabled}
							className={cn(
								"relative flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all overflow-hidden",
								selected
									? "border-emerald-500/60 bg-emerald-500/5"
									: "border-border bg-card hover:border-border/80 hover:bg-muted/30",
								disabled && "opacity-50 cursor-not-allowed",
							)}
						>
							{item.iconUrl ? (
								<img
									src={item.iconUrl}
									alt=""
									className="h-10 w-10 rounded-md object-cover flex-shrink-0"
								/>
							) : (
								<div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-lg flex-shrink-0">
									🎙️
								</div>
							)}
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium truncate">{item.name}</div>
								<div className="text-[10px] text-muted-foreground mt-0.5">
									{item.source === "default" ? "Built-in" : "Custom"}
								</div>
							</div>
							{item.source === "custom" && (
								// biome-ignore lint/a11y/useSemanticElements: nested <button> inside another button is invalid HTML; use role
								<span
									role="button"
									tabIndex={0}
									aria-label="カスタムモデルを削除"
									className="absolute top-1 right-1 h-5 w-5 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center text-muted-foreground"
									onClick={(e) => {
										e.stopPropagation();
										removeCustom(item.uuid);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											e.stopPropagation();
											removeCustom(item.uuid);
										}
									}}
								>
									<HiXMark className="h-3.5 w-3.5" />
								</span>
							)}
						</button>
					);
				})}
			</div>

			<AddModelPresetDialog
				open={addOpen}
				onOpenChange={setAddOpen}
				onAdd={addCustom}
			/>
		</div>
	);
}
