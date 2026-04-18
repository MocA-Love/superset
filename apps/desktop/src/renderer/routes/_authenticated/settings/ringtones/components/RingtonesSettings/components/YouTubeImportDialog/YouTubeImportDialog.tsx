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
import { cn } from "@superset/ui/utils";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { SiYoutube } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AudioEditor } from "../AudioEditor";

const YOUTUBE_URL_HINT =
	/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

type Step = "url" | "installing" | "downloading" | "editor";

interface InstallLogLine {
	id: number;
	time: string;
	message: string;
	level: "info" | "warn" | "error";
}

function formatInstallTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

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
	onImportSuccess: () => void | Promise<void>;
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

	const [installId, setInstallId] = useState<string | null>(null);
	const [installLogs, setInstallLogs] = useState<InstallLogLine[]>([]);
	const installLogIdRef = useRef(0);
	const installLogContainerRef = useRef<HTMLDivElement | null>(null);

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
			setInstallId(null);
		},
		onError: (err) => {
			setErrorMessage(err.message);
		},
	});

	electronTrpc.ringtone.installProgress.useSubscription(
		{ installId: installId ?? "" },
		{
			enabled: installId !== null,
			onData: (event) => {
				if (event.type === "log") {
					setInstallLogs((prev) => {
						installLogIdRef.current += 1;
						return [
							...prev,
							{
								id: installLogIdRef.current,
								time: formatInstallTime(event.time),
								message: event.message,
								level: event.level,
							},
						];
					});
				} else if (event.type === "error") {
					setInstallLogs((prev) => {
						installLogIdRef.current += 1;
						return [
							...prev,
							{
								id: installLogIdRef.current,
								time: formatInstallTime(event.time),
								message: event.message,
								level: "error",
							},
						];
					});
				}
			},
			onError: (err) => {
				// Subscription transport errors shouldn't block the install mutation result.
				console.error("install progress subscription error:", err);
			},
		},
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll on new log lines
	useEffect(() => {
		const el = installLogContainerRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [installLogs]);

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
				await onImportSuccess();
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
		const newInstallId = crypto.randomUUID();
		setStep("installing");
		setErrorMessage(null);
		setInstallLogs([]);
		installLogIdRef.current = 0;
		setInstallId(newInstallId);
		installBinaries.mutate({ installId: newInstallId });
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
				sourceTitle: downloaded.info.title,
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
			<DialogContent
				className={cn(
					"!max-w-lg",
					step === "editor" && "sm:!max-w-[min(95vw,1600px)]",
				)}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SiYoutube className="h-4 w-4 text-red-500" />
						{dialogTitle}
					</DialogTitle>
					<DialogDescription>{dialogDescription}</DialogDescription>
				</DialogHeader>

				{/* Step: installing */}
				{step === "installing" && (
					<div className="space-y-3 py-2">
						<div className="flex items-center gap-3">
							{installBinaries.isPending ? (
								<LuLoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
							) : errorMessage ? (
								<span className="h-2 w-2 rounded-full bg-destructive" />
							) : (
								<span className="h-2 w-2 rounded-full bg-emerald-500" />
							)}
							<p className="text-sm text-muted-foreground">
								{installBinaries.isPending
									? "Running brew install yt-dlp ffmpeg…"
									: errorMessage
										? "Installation failed."
										: "Installation complete."}
							</p>
						</div>

						<div className="rounded-md border border-border bg-muted/20 overflow-hidden">
							<div
								ref={installLogContainerRef}
								className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.55]"
							>
								{installLogs.length === 0 ? (
									<div className="text-muted-foreground/60">
										Waiting for output…
									</div>
								) : (
									installLogs.map((line) => (
										<div
											key={line.id}
											className={
												line.level === "error"
													? "text-red-400"
													: line.level === "warn"
														? "text-amber-400"
														: "text-muted-foreground"
											}
										>
											<span className="text-muted-foreground/60">
												{line.time}
											</span>{" "}
											{line.message}
										</div>
									))
								)}
							</div>
						</div>

						{errorMessage && (
							<p className="text-sm text-destructive break-words">
								{errorMessage}
							</p>
						)}

						<DialogFooter>
							{!installBinaries.isPending && (
								<Button
									type="button"
									variant="ghost"
									onClick={() => {
										setStep("url");
										setErrorMessage(null);
									}}
								>
									Back
								</Button>
							)}
						</DialogFooter>
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
