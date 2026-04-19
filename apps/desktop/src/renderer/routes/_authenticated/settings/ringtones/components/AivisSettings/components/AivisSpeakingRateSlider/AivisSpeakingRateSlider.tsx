import { Label } from "@superset/ui/label";
import { Slider } from "@superset/ui/slider";
import { useEffect, useRef, useState } from "react";
import { HiArrowsRightLeft } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface Props {
	disabled?: boolean;
}

export function AivisSpeakingRateSlider({ disabled }: Props) {
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

	const display = draft ?? data?.speakingRate ?? 1.0;

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<HiArrowsRightLeft className="h-5 w-5 text-muted-foreground flex-shrink-0" />
				<Label htmlFor="aivis-speaking-rate" className="text-sm font-medium">
					Speaking Rate
					<span className="ml-2 text-xs text-muted-foreground">
						{display.toFixed(1)}x
					</span>
				</Label>
			</div>
			<Slider
				id="aivis-speaking-rate"
				value={[display]}
				min={0.5}
				max={2.0}
				step={0.1}
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
					save.mutate({ speakingRate: v });
				}}
			/>
		</div>
	);
}
