import { Label } from "@superset/ui/label";
import { Slider } from "@superset/ui/slider";
import { useState } from "react";
import { HiSpeakerWave } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function VolumeDropdown() {
	const utils = electronTrpc.useUtils();
	const { data: volumeData, isLoading: volumeLoading } =
		electronTrpc.settings.getNotificationVolume.useQuery();
	const volume = volumeData ?? 100;

	const [draftVolume, setDraftVolume] = useState<number | null>(null);
	const displayVolume = draftVolume ?? volume;

	const setVolume = electronTrpc.settings.setNotificationVolume.useMutation({
		onMutate: async ({ volume: newVolume }) => {
			await utils.settings.getNotificationVolume.cancel();
			const previous = utils.settings.getNotificationVolume.getData();
			utils.settings.getNotificationVolume.setData(undefined, newVolume);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getNotificationVolume.setData(
					undefined,
					context.previous,
				);
			}
		},
		onSettled: async () => {
			await utils.settings.getNotificationVolume.invalidate();
		},
	});

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2">
					<HiSpeakerWave className="h-5 w-5 text-muted-foreground flex-shrink-0" />
					<Label htmlFor="notification-volume" className="text-sm font-medium">
						Volume
						<span className="ml-2 text-xs text-muted-foreground">
							{displayVolume}%
						</span>
					</Label>
				</div>
			</div>
			<Slider
				id="notification-volume"
				value={[displayVolume]}
				min={0}
				max={100}
				step={1}
				disabled={volumeLoading}
				onValueChange={(values) => {
					const value = values[0];
					if (typeof value !== "number") return;
					setDraftVolume(value);
				}}
				onValueCommit={(values) => {
					const value = values[0];
					if (typeof value !== "number") return;
					setDraftVolume(null);
					setVolume.mutate({ volume: value });
				}}
			/>
		</div>
	);
}
