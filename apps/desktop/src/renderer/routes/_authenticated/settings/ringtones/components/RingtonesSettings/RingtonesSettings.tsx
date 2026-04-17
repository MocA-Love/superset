import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	HiCheck,
	HiEllipsisHorizontal,
	HiPencil,
	HiPlay,
	HiPlus,
	HiStop,
	HiTrash,
} from "react-icons/hi2";
import { SiYoutube } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	AVAILABLE_RINGTONES,
	type Ringtone,
	useSelectedRingtoneId,
	useSetRingtone,
} from "renderer/stores";
import { CUSTOM_RINGTONE_ID } from "shared/ringtones";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import { DeleteRingtoneDialog } from "./components/DeleteRingtoneDialog";
import { RenameRingtoneDialog } from "./components/RenameRingtoneDialog";
import { VolumeDropdown } from "./components/VolumeDropdown";
import { YouTubeImportDialog } from "./components/YouTubeImportDialog";

function formatDuration(seconds: number): string {
	return `${seconds}s`;
}

interface RingtoneCardProps {
	ringtone: Ringtone;
	isSelected: boolean;
	isPlaying: boolean;
	onSelect: () => void;
	onTogglePlay: () => void;
	onRename?: () => void;
	onDelete?: () => void;
}

function RingtoneCard({
	ringtone,
	isSelected,
	isPlaying,
	onSelect,
	onTogglePlay,
	onRename,
	onDelete,
}: RingtoneCardProps) {
	const showActions = Boolean(onRename || onDelete);

	return (
		// biome-ignore lint/a11y/useSemanticElements: Using div with role="button" to allow nested play/stop button
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			className={cn(
				"relative flex flex-col rounded-lg border-2 overflow-hidden transition-all text-left cursor-pointer",
				isSelected
					? "border-primary ring-2 ring-primary/20"
					: "border-border hover:border-muted-foreground/50",
			)}
		>
			{/* Preview area */}
			<div
				className={cn(
					"h-24 flex items-center justify-center relative",
					isSelected ? "bg-accent/50" : "bg-muted/30",
				)}
			>
				{/* Emoji */}
				<span className="text-4xl">{ringtone.emoji}</span>

				{/* Duration badge */}
				{ringtone.duration && (
					<span className="absolute top-2 right-2 text-xs text-muted-foreground bg-background/80 px-1.5 py-0.5 rounded">
						{formatDuration(ringtone.duration)}
					</span>
				)}

				{/* Actions menu (custom ringtones only) */}
				{showActions && (
					// biome-ignore lint/a11y/noStaticElementInteractions: wrapper exists only to stop click bubbling to the outer card button
					<div
						className="absolute top-1.5 left-1.5"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="Custom ringtone actions"
									className="h-7 w-7 rounded-full flex items-center justify-center bg-background/80 text-foreground border border-border hover:bg-accent"
								>
									<HiEllipsisHorizontal className="h-4 w-4" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								{onRename && (
									<DropdownMenuItem onClick={onRename}>
										<HiPencil className="mr-2 h-4 w-4" />
										Rename
									</DropdownMenuItem>
								)}
								{onDelete && (
									<DropdownMenuItem
										onClick={onDelete}
										className="text-destructive focus:text-destructive"
									>
										<HiTrash className="mr-2 h-4 w-4" />
										Delete
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}

				{/* Play/Stop button */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onTogglePlay();
					}}
					className={cn(
						"absolute bottom-2 right-2 h-8 w-8 rounded-full flex items-center justify-center",
						"transition-colors border",
						isPlaying
							? "bg-destructive text-destructive-foreground border-destructive hover:bg-destructive/90"
							: "bg-card text-foreground border-border hover:bg-accent",
					)}
				>
					{isPlaying ? (
						<HiStop className="h-4 w-4" />
					) : (
						<HiPlay className="h-4 w-4 ml-0.5" />
					)}
				</button>
			</div>

			{/* Info */}
			<div className="p-3 bg-card border-t flex items-center justify-between">
				<div>
					<div className="text-sm font-medium">{ringtone.name}</div>
					<div className="text-xs text-muted-foreground">
						{ringtone.description}
					</div>
				</div>
				{isSelected && (
					<div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
						<HiCheck className="h-3 w-3 text-primary-foreground" />
					</div>
				)}
			</div>
		</div>
	);
}

interface RingtonesSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function RingtonesSettings({ visibleItems }: RingtonesSettingsProps) {
	const showNotification = isItemVisible(
		SETTING_ITEM_ID.RINGTONES_NOTIFICATION,
		visibleItems,
	);

	const selectedRingtoneId = useSelectedRingtoneId();
	const setRingtone = useSetRingtone();
	const [playingId, setPlayingId] = useState<string | null>(null);
	const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const utils = electronTrpc.useUtils();
	const { data: customRingtoneData } =
		electronTrpc.ringtone.getCustom.useQuery();
	const { data: isMutedData, isLoading: isMutedLoading } =
		electronTrpc.settings.getNotificationSoundsMuted.useQuery();
	const { data: volumeData } =
		electronTrpc.settings.getNotificationVolume.useQuery();
	const isMuted = isMutedData ?? false;
	const volume = volumeData ?? 100;
	const customRingtone: Ringtone | null = customRingtoneData
		? {
				...customRingtoneData,
				filename: "",
				color: "from-slate-400 to-slate-500",
			}
		: null;
	const ringtoneOptions = customRingtone
		? [...AVAILABLE_RINGTONES, customRingtone]
		: AVAILABLE_RINGTONES;

	const setMuted = electronTrpc.settings.setNotificationSoundsMuted.useMutation(
		{
			onMutate: async ({ muted }) => {
				await utils.settings.getNotificationSoundsMuted.cancel();
				const previous = utils.settings.getNotificationSoundsMuted.getData();
				utils.settings.getNotificationSoundsMuted.setData(undefined, muted);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getNotificationSoundsMuted.setData(
						undefined,
						context.previous,
					);
				}
			},
		},
	);
	const importCustomRingtone = electronTrpc.ringtone.importCustom.useMutation({
		onError: (error) => {
			console.error("Failed to import custom ringtone:", error);
		},
		onSuccess: async (result) => {
			if (result.canceled) {
				return;
			}
			await utils.ringtone.getCustom.invalidate();
			setRingtone(CUSTOM_RINGTONE_ID);
		},
	});

	const [youtubeDialogOpen, setYoutubeDialogOpen] = useState(false);
	const [youtubeError, setYoutubeError] = useState<string | null>(null);
	const importFromYouTube = electronTrpc.ringtone.importFromYouTube.useMutation(
		{
			onSuccess: async () => {
				setYoutubeError(null);
				setYoutubeDialogOpen(false);
				await utils.ringtone.getCustom.invalidate();
				setRingtone(CUSTOM_RINGTONE_ID);
			},
			onError: (error) => {
				setYoutubeError(error.message);
			},
		},
	);

	const [renameDialogOpen, setRenameDialogOpen] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	const renameCustomRingtone = electronTrpc.ringtone.renameCustom.useMutation({
		onSuccess: async () => {
			setRenameError(null);
			setRenameDialogOpen(false);
			await utils.ringtone.getCustom.invalidate();
		},
		onError: (error) => {
			setRenameError(error.message);
		},
	});

	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const deleteCustomRingtone = electronTrpc.ringtone.deleteCustom.useMutation({
		onSuccess: async () => {
			if (selectedRingtoneId === CUSTOM_RINGTONE_ID) {
				setRingtone(AVAILABLE_RINGTONES[0]?.id ?? "");
			}
			setDeleteError(null);
			setDeleteDialogOpen(false);
			await utils.ringtone.getCustom.invalidate();
		},
		onError: (error) => {
			setDeleteError(error.message);
		},
	});

	const handleMutedToggle = (enabled: boolean) => {
		setMuted.mutate({ muted: !enabled });
	};

	const handleImportCustomRingtone = useCallback(() => {
		importCustomRingtone.mutate();
	}, [importCustomRingtone]);

	const handleRenameCustom = useCallback(() => {
		setRenameError(null);
		setRenameDialogOpen(true);
	}, []);

	const handleDeleteCustom = useCallback(() => {
		setDeleteError(null);
		setDeleteDialogOpen(true);
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		await deleteCustomRingtone.mutateAsync().catch(() => {
			// Error surfaced via deleteError state.
		});
	}, [deleteCustomRingtone]);

	// Clean up timer and stop any playing sound on unmount
	useEffect(() => {
		return () => {
			if (previewTimerRef.current) {
				clearTimeout(previewTimerRef.current);
			}
			// Stop any in-progress preview when navigating away
			electronTrpcClient.ringtone.stop.mutate().catch(() => {
				// Ignore errors during cleanup
			});
		};
	}, []);

	const handleTogglePlay = useCallback(
		async (ringtone: Ringtone) => {
			// Clear any pending timer
			if (previewTimerRef.current) {
				clearTimeout(previewTimerRef.current);
				previewTimerRef.current = null;
			}

			// If this ringtone is already playing, stop it
			if (playingId === ringtone.id) {
				try {
					await electronTrpcClient.ringtone.stop.mutate();
				} catch (error) {
					console.error("Failed to stop ringtone:", error);
				}
				setPlayingId(null);
				return;
			}

			// Stop any currently playing sound first
			try {
				await electronTrpcClient.ringtone.stop.mutate();
			} catch (error) {
				console.error("Failed to stop ringtone:", error);
			}

			// Play the new sound
			setPlayingId(ringtone.id);

			try {
				await electronTrpcClient.ringtone.preview.mutate({
					ringtoneId: ringtone.id,
					volume,
				});
			} catch (error) {
				console.error("Failed to play ringtone:", error);
				setPlayingId(null);
			}

			// Auto-reset after the ringtone's actual duration (with 500ms buffer)
			const durationMs = ((ringtone.duration ?? 5) + 0.5) * 1000;
			previewTimerRef.current = setTimeout(() => {
				setPlayingId((current) => (current === ringtone.id ? null : current));
				previewTimerRef.current = null;
			}, durationMs);
		},
		[playingId, volume],
	);

	const handleSelect = useCallback(
		(ringtoneId: string) => {
			setRingtone(ringtoneId);
		},
		[setRingtone],
	);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Notifications</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Choose the notification sound for completed tasks
				</p>
			</div>

			<div className="space-y-8">
				{/* Sound Toggle */}
				{showNotification && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label
								htmlFor="notification-sounds"
								className="text-sm font-medium"
							>
								Notification sounds
							</Label>
							<p className="text-xs text-muted-foreground">
								Play a sound when tasks complete
							</p>
						</div>
						<Switch
							id="notification-sounds"
							checked={!isMuted}
							onCheckedChange={handleMutedToggle}
							disabled={isMutedLoading || setMuted.isPending}
						/>
					</div>
				)}

				{/* Volume Dropdown */}
				{showNotification && !isMuted && <VolumeDropdown />}

				{/* Ringtone Section */}
				{showNotification && !isMuted && (
					<div>
						<div className="mb-4 flex items-center justify-between gap-2">
							<h3 className="text-sm font-medium">Notification Sound</h3>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => {
										setYoutubeError(null);
										setYoutubeDialogOpen(true);
									}}
									disabled={importFromYouTube.isPending}
								>
									<SiYoutube className="mr-1.5 h-3.5 w-3.5" />
									From YouTube
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={handleImportCustomRingtone}
									disabled={importCustomRingtone.isPending}
								>
									<HiPlus className="mr-1.5 h-3.5 w-3.5" />
									{customRingtone ? "Replace Custom Audio" : "Add Custom Audio"}
								</Button>
							</div>
						</div>
						<div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
							{ringtoneOptions.map((ringtone) => {
								const isCustom = ringtone.id === CUSTOM_RINGTONE_ID;
								return (
									<RingtoneCard
										key={ringtone.id}
										ringtone={ringtone}
										isSelected={selectedRingtoneId === ringtone.id}
										isPlaying={playingId === ringtone.id}
										onSelect={() => handleSelect(ringtone.id)}
										onTogglePlay={() => handleTogglePlay(ringtone)}
										onRename={isCustom ? handleRenameCustom : undefined}
										onDelete={isCustom ? handleDeleteCustom : undefined}
									/>
								);
							})}
						</div>
					</div>
				)}

				{/* Tip */}
				{showNotification && !isMuted && (
					<div className="pt-6 border-t">
						<p className="text-sm text-muted-foreground">
							Click the play button to preview a sound. Use Add Custom Audio to
							import your own .mp3, .wav, or .ogg file, or From YouTube to clip
							a section from a YouTube video.
						</p>
					</div>
				)}
			</div>

			<YouTubeImportDialog
				open={youtubeDialogOpen}
				onOpenChange={(open) => {
					setYoutubeDialogOpen(open);
					if (!open) setYoutubeError(null);
				}}
				onSubmit={async (input) => {
					await importFromYouTube.mutateAsync(input).catch(() => {
						// Error surfaced via youtubeError state.
					});
				}}
				isSubmitting={importFromYouTube.isPending}
				errorMessage={youtubeError}
			/>

			<DeleteRingtoneDialog
				open={deleteDialogOpen}
				onOpenChange={(open) => {
					setDeleteDialogOpen(open);
					if (!open) setDeleteError(null);
				}}
				ringtoneName={customRingtone?.name ?? ""}
				onConfirm={handleConfirmDelete}
				isSubmitting={deleteCustomRingtone.isPending}
				errorMessage={deleteError}
			/>

			<RenameRingtoneDialog
				open={renameDialogOpen}
				onOpenChange={(open) => {
					setRenameDialogOpen(open);
					if (!open) setRenameError(null);
				}}
				currentName={customRingtone?.name ?? ""}
				onSubmit={async (name) => {
					await renameCustomRingtone.mutateAsync({ name }).catch(() => {
						// Error surfaced via renameError state.
					});
				}}
				isSubmitting={renameCustomRingtone.isPending}
				errorMessage={renameError}
			/>
		</div>
	);
}
