import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Slider } from "@superset/ui/slider";
import { Switch } from "@superset/ui/switch";
import { useEffect, useState } from "react";
import { useVibrancyStore } from "renderer/stores/vibrancy";
import {
	VIBRANCY_OPACITY_MAX,
	VIBRANCY_OPACITY_MIN,
	type VibrancyBlurLevel,
} from "shared/vibrancy-types";

const BLUR_OPTIONS: Array<{ value: VibrancyBlurLevel; label: string }> = [
	{ value: "subtle", label: "弱 (sidebar)" },
	{ value: "standard", label: "標準 (header)" },
	{ value: "strong", label: "強 (content)" },
	{ value: "ultra", label: "最強 (fullscreen-ui)" },
];

export function VibrancySection() {
	const hydrated = useVibrancyStore((s) => s.hydrated);
	const supported = useVibrancyStore((s) => s.supported);
	const enabled = useVibrancyStore((s) => s.enabled);
	const opacity = useVibrancyStore((s) => s.opacity);
	const blurLevel = useVibrancyStore((s) => s.blurLevel);
	const setState = useVibrancyStore((s) => s.setState);
	const previewOpacity = useVibrancyStore((s) => s.previewOpacity);

	// Drag-local opacity: drives the slider thumb and a CSS preview via the
	// `--vibrancy-alpha` variable, so the window updates in real time without
	// hitting the filesystem on every tick. Persistence happens on commit.
	const [draftOpacity, setDraftOpacity] = useState<number | null>(null);
	const displayOpacity = draftOpacity ?? opacity;

	useEffect(() => {
		// index.tsx already kicks off hydrate at startup; this is a safety net
		// for cold settings-only flows. The store itself dedupes concurrent
		// calls via an in-flight promise so repeated invocations are cheap.
		if (!hydrated) {
			void useVibrancyStore.getState().hydrate();
		}
	}, [hydrated]);

	if (!supported) {
		return (
			<div>
				<h3 className="text-sm font-medium">ウィンドウ透過</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					この機能は現在 macOS でのみ利用できます。
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<div>
				<h3 className="text-sm font-medium">ウィンドウ透過 (macOS)</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					Warp
					のようにウィンドウ全体を半透明にし、背景をぼかしてデスクトップが透けて見えるようにします。
					ブラウザペイン (webview) は macOS
					の制約により透過できず、不透明のまま残ります。
				</p>
			</div>

			<div className="flex items-center justify-between gap-4">
				<div className="space-y-0.5">
					<Label htmlFor="vibrancy-enabled" className="text-sm font-medium">
						透過を有効にする
					</Label>
					<p className="text-xs text-muted-foreground">
						メインウィンドウと tearoff ウィンドウに適用されます。
					</p>
				</div>
				<Switch
					id="vibrancy-enabled"
					checked={enabled}
					onCheckedChange={(checked) => {
						void setState({ enabled: checked });
					}}
				/>
			</div>

			<div className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<Label className="text-sm font-medium">
						不透明度
						<span className="ml-2 text-xs text-muted-foreground">
							{displayOpacity}%
						</span>
					</Label>
				</div>
				<Slider
					value={[displayOpacity]}
					min={VIBRANCY_OPACITY_MIN}
					max={VIBRANCY_OPACITY_MAX}
					step={1}
					disabled={!enabled || !hydrated}
					onValueChange={(values) => {
						const value = values[0];
						if (typeof value !== "number") return;
						setDraftOpacity(value);
						// Live-preview via the store so all CSS variable
						// overlays are recomputed — no disk write, no IPC.
						previewOpacity(value);
					}}
					onValueCommit={(values) => {
						const value = values[0];
						if (typeof value !== "number") return;
						setDraftOpacity(null);
						void setState({ opacity: value });
					}}
				/>
				<p className="text-xs text-muted-foreground">
					0%
					に近づくほど背景がよく透けて見えます。低すぎると文字が読みづらくなるのでご注意ください。
				</p>
			</div>

			<div className="space-y-2">
				<Label className="text-sm font-medium">ブラー強度</Label>
				<Select
					value={blurLevel}
					disabled={!enabled || !hydrated}
					onValueChange={(value) => {
						void setState({ blurLevel: value as VibrancyBlurLevel });
					}}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{BLUR_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					macOS の NSVisualEffectView の material
					を切り替えることで、ブラーの強さを段階的に変更します。
				</p>
			</div>
		</div>
	);
}
