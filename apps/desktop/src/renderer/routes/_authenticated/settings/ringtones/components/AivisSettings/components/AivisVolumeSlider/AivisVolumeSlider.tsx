import { Label } from "@superset/ui/label";
import { Slider } from "@superset/ui/slider";
import { useEffect, useRef, useState } from "react";
import { HiSpeakerWave } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface Props {
	disabled?: boolean;
}

export function AivisVolumeSlider({ disabled }: Props) {
	const utils = electronTrpc.useUtils();
	const { data } = electronTrpc.settings.getAivisSettings.useQuery();
	const save = electronTrpc.settings.setAivisSettings.useMutation({
		onSuccess: () => utils.settings.getAivisSettings.invalidate(),
	});

	const [draft, setDraft] = useState<number | null>(null);
	const hydrated = useRef(false);

	useEffect(() => {
		if (!data || hydrated.current) return;
		hydrated.current = true;
	}, [data]);

	const display = draft ?? data?.volume ?? 100;

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<HiSpeakerWave className="h-5 w-5 text-muted-foreground flex-shrink-0" />
				<Label htmlFor="aivis-volume" className="text-sm font-medium">
					Volume
					<span className="ml-2 text-xs text-muted-foreground">{display}%</span>
				</Label>
			</div>
			<Slider
				id="aivis-volume"
				value={[display]}
				min={0}
				max={100}
				step={1}
				disabled={disabled}
				onValueChange={(values) => {
					const v = values[0];
					if (typeof v !== "number") return;
					setDraft(v);
				}}
				onValueCommit={(values) => {
					const v = values[0];
					if (typeof v !== "number") return;
					setDraft(null);
					save.mutate({ volume: v });
				}}
			/>
		</div>
	);
}
