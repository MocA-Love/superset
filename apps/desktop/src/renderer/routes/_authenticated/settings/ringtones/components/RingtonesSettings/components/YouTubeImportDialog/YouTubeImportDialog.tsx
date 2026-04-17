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
import { useEffect, useId, useMemo, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";

const MAX_DURATION_SECONDS = 30;

interface YouTubeImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (input: {
		url: string;
		startSeconds: number;
		durationSeconds: number;
		displayName?: string;
	}) => Promise<void>;
	isSubmitting: boolean;
	errorMessage?: string | null;
}

const YOUTUBE_URL_HINT =
	/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

function clampNonNegativeInt(value: string, max?: number): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return max !== undefined ? Math.min(parsed, max) : parsed;
}

export function YouTubeImportDialog({
	open,
	onOpenChange,
	onSubmit,
	isSubmitting,
	errorMessage,
}: YouTubeImportDialogProps) {
	const urlId = useId();
	const startId = useId();
	const durationId = useId();
	const nameId = useId();

	const [url, setUrl] = useState("");
	const [startMin, setStartMin] = useState("0");
	const [startSec, setStartSec] = useState("0");
	const [duration, setDuration] = useState("5");
	const [displayName, setDisplayName] = useState("");

	useEffect(() => {
		if (!open) {
			setUrl("");
			setStartMin("0");
			setStartSec("0");
			setDuration("5");
			setDisplayName("");
		}
	}, [open]);

	const startSeconds =
		clampNonNegativeInt(startMin) * 60 + clampNonNegativeInt(startSec, 59);
	const durationSeconds = clampNonNegativeInt(duration, MAX_DURATION_SECONDS);

	const urlLooksValid = useMemo(() => YOUTUBE_URL_HINT.test(url.trim()), [url]);
	const durationValid =
		durationSeconds >= 1 && durationSeconds <= MAX_DURATION_SECONDS;
	const canSubmit =
		urlLooksValid && durationValid && !isSubmitting && url.trim().length > 0;

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canSubmit) return;
		await onSubmit({
			url: url.trim(),
			startSeconds,
			durationSeconds,
			displayName: displayName.trim() || undefined,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Import from YouTube</DialogTitle>
					<DialogDescription>
						Paste a YouTube URL and choose a clip range. Requires{" "}
						<code className="rounded bg-muted px-1 text-xs">yt-dlp</code> and{" "}
						<code className="rounded bg-muted px-1 text-xs">ffmpeg</code> to be
						installed locally.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={urlId}>YouTube URL</Label>
						<Input
							id={urlId}
							type="url"
							placeholder="https://www.youtube.com/watch?v=..."
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							autoFocus
							disabled={isSubmitting}
						/>
						{url.length > 0 && !urlLooksValid && (
							<p className="text-xs text-destructive">
								Enter a youtube.com or youtu.be URL.
							</p>
						)}
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor={startId}>Start time</Label>
							<div className="flex items-center gap-2">
								<Input
									id={startId}
									type="number"
									min={0}
									value={startMin}
									onChange={(event) => setStartMin(event.target.value)}
									disabled={isSubmitting}
									className="w-16"
								/>
								<span className="text-xs text-muted-foreground">min</span>
								<Input
									type="number"
									min={0}
									max={59}
									value={startSec}
									onChange={(event) => setStartSec(event.target.value)}
									disabled={isSubmitting}
									className="w-16"
								/>
								<span className="text-xs text-muted-foreground">sec</span>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor={durationId}>Duration (sec)</Label>
							<Input
								id={durationId}
								type="number"
								min={1}
								max={MAX_DURATION_SECONDS}
								value={duration}
								onChange={(event) => setDuration(event.target.value)}
								disabled={isSubmitting}
							/>
							<p className="text-xs text-muted-foreground">
								Max {MAX_DURATION_SECONDS} seconds.
							</p>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor={nameId}>Display name (optional)</Label>
						<Input
							id={nameId}
							type="text"
							placeholder="My YouTube clip"
							value={displayName}
							onChange={(event) => setDisplayName(event.target.value)}
							disabled={isSubmitting}
							maxLength={80}
						/>
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
							disabled={isSubmitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!canSubmit}>
							{isSubmitting && (
								<LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
							)}
							{isSubmitting ? "Importing..." : "Import"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
