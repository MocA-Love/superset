import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { useEffect, useRef, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { SiYoutube } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AudioEditor } from "../AudioEditor";

interface EditCustomRingtoneDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentDisplayName: string;
	currentThumbnailUrl?: string;
	onSaveSuccess: () => void | Promise<void>;
}

export function EditCustomRingtoneDialog({
	open,
	onOpenChange,
	currentDisplayName,
	currentThumbnailUrl,
	onSaveSuccess,
}: EditCustomRingtoneDialogProps) {
	const editStateQuery = electronTrpc.ringtone.getCustomEditState.useQuery(
		undefined,
		{ enabled: open, staleTime: 0 },
	);
	const { mutateAsync: openCustomSource } =
		electronTrpc.ringtone.openCustomSource.useMutation();
	const { mutate: closeCustomSource } =
		electronTrpc.ringtone.closeCustomSource.useMutation();
	const reEdit = electronTrpc.ringtone.reEditCustom.useMutation();

	const [tempId, setTempId] = useState<string | null>(null);
	const [displayName, setDisplayName] = useState(currentDisplayName);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const openedTempIdRef = useRef<string | null>(null);

	// Swallow stray pointer/focus events that fire right after opening from a
	// DropdownMenu item (otherwise the menu's closing pointerup is treated as
	// an outside-click and dismisses this dialog immediately).
	const openedAtRef = useRef(0);
	useEffect(() => {
		if (open) openedAtRef.current = Date.now();
	}, [open]);
	const guardOutside = (event: Event) => {
		if (Date.now() - openedAtRef.current < 300) {
			event.preventDefault();
		}
	};

	// Acquire a temp-audio tempId for the saved source when the dialog opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		openCustomSource()
			.then((result) => {
				if (cancelled) return;
				if (result.tempId) {
					setTempId(result.tempId);
					openedTempIdRef.current = result.tempId;
				} else {
					setErrorMessage(
						"No saved source audio for this ringtone. Re-import from YouTube to enable editing.",
					);
				}
			})
			.catch((err: Error) => {
				if (!cancelled) setErrorMessage(err.message);
			});
		return () => {
			cancelled = true;
		};
	}, [open, openCustomSource]);

	// Release the tempId when the dialog closes.
	useEffect(() => {
		if (open) return;
		const id = openedTempIdRef.current;
		if (id) {
			closeCustomSource({ tempId: id });
			openedTempIdRef.current = null;
		}
		setTempId(null);
		setErrorMessage(null);
		setDisplayName(currentDisplayName);
	}, [open, closeCustomSource, currentDisplayName]);

	useEffect(() => {
		if (open) setDisplayName(currentDisplayName);
	}, [open, currentDisplayName]);

	const editState = editStateQuery.data;
	const isLoading = editStateQuery.isLoading || (!tempId && !errorMessage);

	const handleSave = async (params: {
		startSeconds: number;
		endSeconds: number;
		fadeInSeconds: number;
		fadeOutSeconds: number;
		playbackRate: number;
	}) => {
		setErrorMessage(null);
		try {
			await reEdit.mutateAsync({
				startSeconds: params.startSeconds,
				endSeconds: params.endSeconds,
				fadeInSeconds:
					params.fadeInSeconds > 0 ? params.fadeInSeconds : undefined,
				fadeOutSeconds:
					params.fadeOutSeconds > 0 ? params.fadeOutSeconds : undefined,
				playbackRate:
					params.playbackRate !== 1.0 ? params.playbackRate : undefined,
				displayName: displayName.trim() || undefined,
			});
			await onSaveSuccess();
			onOpenChange(false);
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (reEdit.isPending) return;
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="!max-w-lg sm:!max-w-[min(95vw,1600px)]"
				onPointerDownOutside={guardOutside}
				onInteractOutside={guardOutside}
				onFocusOutside={guardOutside}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SiYoutube className="h-4 w-4 text-red-500" />
						Edit Clip
					</DialogTitle>
					<DialogDescription>
						Adjust the range, fade, and speed, then save to re-encode the
						ringtone.
					</DialogDescription>
				</DialogHeader>

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<LuLoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : errorMessage && !tempId ? (
					<p className="text-sm text-destructive break-words py-4">
						{errorMessage}
					</p>
				) : tempId ? (
					<AudioEditor
						tempId={tempId}
						videoTitle={editState?.sourceTitle ?? currentDisplayName}
						thumbnailUrl={currentThumbnailUrl ?? ""}
						totalDuration={editState?.endSeconds ?? 0}
						displayName={displayName}
						onDisplayNameChange={setDisplayName}
						onImport={handleSave}
						isImporting={reEdit.isPending}
						errorMessage={errorMessage}
						initialStartSeconds={editState?.startSeconds}
						initialEndSeconds={editState?.endSeconds}
						initialFadeIn={editState?.fadeInSeconds}
						initialFadeOut={editState?.fadeOutSeconds}
						initialPlaybackRate={editState?.playbackRate}
						submitLabel="Save"
						submittingLabel="Saving..."
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
