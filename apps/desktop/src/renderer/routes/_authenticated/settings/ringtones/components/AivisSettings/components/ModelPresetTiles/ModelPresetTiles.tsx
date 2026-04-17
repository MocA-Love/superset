import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { HiPlay, HiPlus, HiStop, HiXMark } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AddModelPresetDialog } from "../AddModelPresetDialog";
import { AIVIS_PRESET_MODELS } from "./preset-data";

interface PresetItem {
	uuid: string;
	name: string;
	icon: string | null;
	sample: string | null;
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

	const items: PresetItem[] = useMemo(() => {
		const seen = new Set<string>();
		const out: PresetItem[] = [];
		for (const m of AIVIS_PRESET_MODELS) {
			if (seen.has(m.uuid)) continue;
			seen.add(m.uuid);
			out.push({
				uuid: m.uuid,
				name: m.name,
				icon: m.iconAsset,
				sample: m.sampleAsset,
				source: "default",
			});
		}
		for (const p of customPresets) {
			if (seen.has(p.uuid)) continue;
			seen.add(p.uuid);
			out.push({
				uuid: p.uuid,
				name: p.name,
				icon: p.iconUrl,
				sample: p.sampleUrl ?? null,
				source: "custom",
			});
		}
		return out;
	}, [customPresets]);

	const [playingUuid, setPlayingUuid] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		return () => {
			audioRef.current?.pause();
			audioRef.current = null;
		};
	}, []);

	const togglePreview = (uuid: string, src: string | null) => {
		if (!src) return;
		if (playingUuid === uuid) {
			audioRef.current?.pause();
			setPlayingUuid(null);
			return;
		}
		audioRef.current?.pause();
		const audio = new Audio(src);
		audioRef.current = audio;
		audio.onended = () => setPlayingUuid((c) => (c === uuid ? null : c));
		audio.onerror = () => setPlayingUuid((c) => (c === uuid ? null : c));
		audio.play().catch(() => setPlayingUuid((c) => (c === uuid ? null : c)));
		setPlayingUuid(uuid);
	};

	const removeCustom = (uuid: string) => {
		const next = customPresets.filter((p) => p.uuid !== uuid);
		save.mutate({ modelPresets: next });
		if (currentModelUuid === uuid) {
			// Sync both the persisted setting AND the parent's local form state,
			// since AivisSettings hydrates once and would otherwise keep showing
			// the deleted UUID in the Model UUID input / test playback flow.
			save.mutate({ modelUuid: "" });
			onSelect("");
		}
	};

	const addCustom = (preset: {
		uuid: string;
		name: string;
		iconUrl: string | null;
		sampleUrl: string | null;
	}) => {
		const exists = customPresets.some((p) => p.uuid === preset.uuid);
		const next = exists ? customPresets : [...customPresets, preset];
		save.mutate({ modelPresets: next });
		onSelect(preset.uuid);
	};

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

			<div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
				{items.map((item) => {
					const selected = currentModelUuid === item.uuid;
					const isPlaying = playingUuid === item.uuid;
					return (
						// biome-ignore lint/a11y/useSemanticElements: nested buttons invalid; use div + role
						<div
							key={item.uuid}
							role="button"
							tabIndex={disabled ? -1 : 0}
							onClick={() => !disabled && onSelect(item.uuid)}
							onKeyDown={(e) => {
								if (disabled) return;
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelect(item.uuid);
								}
							}}
							className={cn(
								"relative flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-all overflow-hidden cursor-pointer",
								selected
									? "border-emerald-500/60 bg-emerald-500/5"
									: "border-border bg-card hover:border-border/80 hover:bg-muted/30",
								disabled && "opacity-50 cursor-not-allowed",
							)}
						>
							{item.icon ? (
								<img
									src={item.icon}
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
							{item.sample && (
								<button
									type="button"
									aria-label={isPlaying ? "停止" : "サンプル再生"}
									className="h-7 w-7 rounded-md bg-muted hover:bg-muted-foreground/20 flex items-center justify-center text-foreground"
									onClick={(e) => {
										e.stopPropagation();
										togglePreview(item.uuid, item.sample);
									}}
								>
									{isPlaying ? (
										<HiStop className="h-3.5 w-3.5" />
									) : (
										<HiPlay className="h-3.5 w-3.5" />
									)}
								</button>
							)}
							{item.source === "custom" && (
								// biome-ignore lint/a11y/useSemanticElements: nested buttons invalid; use span + role
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
						</div>
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
