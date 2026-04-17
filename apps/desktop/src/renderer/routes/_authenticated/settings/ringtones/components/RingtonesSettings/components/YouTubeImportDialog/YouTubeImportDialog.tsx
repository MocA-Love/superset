import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { SiYoutube } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AudioEditor } from "./components/AudioEditor";

const YOUTUBE_URL_HINT =
	/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

type Step = "url" | "installing" | "downloading" | "editor";

interface DownloadedAudioState {
	tempId: string;
	tempPath: string;
	info: {
		title: string;
		thumbnailUrl: string;
		durationSeconds: number;
	};
}

interface YouTubeImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportSuccess: () => void;
}

export function YouTubeImportDialog({
	open,
	onOpenChange,
	onImportSuccess,
}: YouTubeImportDialogProps) {
	const urlId = useId();

	const [step, setStep] = useState<Step>("url");
	const [url, setUrl] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [downloaded, setDownloaded] = useState<DownloadedAudioState | null>(
		null,
	);
	const [displayName, setDisplayName] = useState("");

	// Binary check
	const { data: binariesData, refetch: refetchBinaries } =
		electronTrpc.ringtone.checkBinaries.useQuery(undefined, {
			enabled: open,
			staleTime: 10_000,
		});
	const missingBinaries = binariesData?.missing ?? [];
	const hasMissingBinaries = missingBinaries.length > 0;

	const installBinaries = electronTrpc.ringtone.installBinaries.useMutation({
		onSuccess: async () => {
			await refetchBinaries();
			setStep("url");
			setErrorMessage(null);
		},
		onError: (err) => {
			setErrorMessage(err.message);
			setStep("url");
		},
	});

	const downloadAudio = electronTrpc.ringtone.downloadYouTubeAudio.useMutation({
		onSuccess: (result) => {
			setDownloaded({
				tempId: result.tempId,
				tempPath: result.tempId,
				info: result.info,
			});
			setDisplayName(result.info.title.slice(0, 80));
			setStep("editor");
			setErrorMessage(null);
		},
		onError: (err) => {
			setErrorMessage(err.message);
			setStep("url");
		},
	});

	const cleanupTempAudio = electronTrpc.ringtone.cleanupTempAudio.useMutation();

	const importFromYouTube = electronTrpc.ringtone.importFromYouTube.useMutation(
		{
			onSuccess: async () => {
				if (downloaded) {
					cleanupTempAudio.mutate({ tempId: downloaded.tempId });
				}
				setErrorMessage(null);
				onImportSuccess();
				onOpenChange(false);
			},
			onError: (err) => {
				setErrorMessage(err.message);
			},
		},
	);

	const resetState = useCallback(() => {
		setStep("url");
		setUrl("");
		setErrorMessage(null);
		setDisplayName("");
		if (downloaded) {
			cleanupTempAudio.mutate({ tempId: downloaded.tempId });
			setDownloaded(null);
		}
	}, [downloaded, cleanupTempAudio]);

	useEffect(() => {
		if (!open) {
			resetState();
		}
	}, [open, resetState]);

	const urlLooksValid = useMemo(() => YOUTUBE_URL_HINT.test(url.trim()), [url]);

	const handleInstall = () => {
		setStep("installing");
		setErrorMessage(null);
		installBinaries.mutate();
	};

	const handleLoad = () => {
		if (!urlLooksValid) return;
		setStep("downloading");
		setErrorMessage(null);
		downloadAudio.mutate({ url: url.trim() });
	};

	const handleImport = useCallback(
		async (params: {
			startSeconds: number;
			endSeconds: number;
			fadeInSeconds: number;
			fadeOutSeconds: number;
			playbackRate: number;
		}) => {
			if (!downloaded) return;
			await importFromYouTube.mutateAsync({
				url: url.trim(),
				startSeconds: params.startSeconds,
				endSeconds: params.endSeconds,
				displayName: displayName.trim() || undefined,
				thumbnailUrl: downloaded.info.thumbnailUrl || undefined,
				fadeInSeconds:
					params.fadeInSeconds > 0 ? params.fadeInSeconds : undefined,
				fadeOutSeconds:
					params.fadeOutSeconds > 0 ? params.fadeOutSeconds : undefined,
				playbackRate:
					params.playbackRate !== 1.0 ? params.playbackRate : undefined,
				tempId: downloaded.tempId,
			});
		},
		[downloaded, url, displayName, importFromYouTube],
	);

	const isLoading = step === "downloading" || step === "installing";

	const dialogTitle = step === "editor" ? "Edit Clip" : "Import from YouTube";
	const dialogDescription =
		step === "editor"
			? "Set the clip range, fade, and speed, then import."
			: step === "downloading"
				? "Downloading audio…"
				: step === "installing"
					? "Installing dependencies…"
					: hasMissingBinaries
						? "Required tools are not installed."
						: "Paste a YouTube URL and load the audio to edit.";

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!isLoading && !importFromYouTube.isPending) onOpenChange(o);
			}}
		>
			<DialogContent className="!max-w-lg sm:!max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SiYoutube className="h-4 w-4 text-red-500" />
						{dialogTitle}
					</DialogTitle>
					<DialogDescription>{dialogDescription}</DialogDescription>
				</DialogHeader>

				{/* Step: installing */}
				{step === "installing" && (
					<div className="flex flex-col items-center gap-4 py-6">
						<LuLoaderCircle className="h-8 w-8 animate-spin text-muted-foreground" />
						<p className="text-sm text-center text-muted-foreground">
							Running{" "}
							<code className="rounded bg-muted px-1">
								brew install yt-dlp ffmpeg
							</code>
							<br />
							This may take a few minutes…
						</p>
						{errorMessage && (
							<p className="text-sm text-destructive break-words text-center">
								{errorMessage}
							</p>
						)}
					</div>
				)}

				{/* Step: downloading */}
				{step === "downloading" && (
					<div className="flex flex-col items-center gap-4 py-6">
						<LuLoaderCircle className="h-8 w-8 animate-spin text-muted-foreground" />
						<p className="text-sm text-muted-foreground">
							Downloading audio from YouTube…
						</p>
					</div>
				)}

				{/* Step: url */}
				{step === "url" && (
					<div className="space-y-4">
						{/* Missing binaries notice */}
						{hasMissingBinaries && (
							<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
								<p className="text-sm text-amber-700 dark:text-amber-400">
									Required tools not found:{" "}
									<code className="rounded bg-muted px-1 text-xs">
										{missingBinaries.join(", ")}
									</code>
								</p>
								{process.platform === "darwin" ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={handleInstall}
										className="gap-1.5"
									>
										Install with Homebrew
									</Button>
								) : (
									<p className="text-xs text-muted-foreground">
										Please install{" "}
										<code className="rounded bg-muted px-1">yt-dlp</code> and{" "}
										<code className="rounded bg-muted px-1">ffmpeg</code> via
										your package manager.
									</p>
								)}
							</div>
						)}

						<div className="space-y-2">
							<Label htmlFor={urlId}>YouTube URL</Label>
							<Input
								id={urlId}
								type="url"
								placeholder="https://www.youtube.com/watch?v=..."
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								autoFocus
								disabled={hasMissingBinaries}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										urlLooksValid &&
										!hasMissingBinaries
									) {
										handleLoad();
									}
								}}
							/>
							{url.length > 0 && !urlLooksValid && (
								<p className="text-xs text-destructive">
									Enter a youtube.com or youtu.be URL.
								</p>
							)}
						</div>

						{errorMessage && (
							<p className="text-sm text-destructive break-words">
								{errorMessage}
							</p>
						)}

						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								disabled={!urlLooksValid || hasMissingBinaries}
								onClick={handleLoad}
							>
								Load Audio
							</Button>
						</DialogFooter>
					</div>
				)}

				{/* Step: editor */}
				{step === "editor" && downloaded && (
					<AudioEditor
						tempId={downloaded.tempId}
						videoTitle={downloaded.info.title}
						thumbnailUrl={downloaded.info.thumbnailUrl}
						totalDuration={downloaded.info.durationSeconds}
						displayName={displayName}
						onDisplayNameChange={setDisplayName}
						onImport={handleImport}
						isImporting={importFromYouTube.isPending}
						errorMessage={errorMessage}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
