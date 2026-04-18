import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { Slider } from "@superset/ui/slider";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HiPlay, HiStop } from "react-icons/hi2";
import { LuLoaderCircle } from "react-icons/lu";

const MAX_OUTPUT_DURATION = 30;

interface AudioEditorProps {
	tempId: string;
	videoTitle: string;
	thumbnailUrl: string;
	totalDuration: number;
	displayName: string;
	onDisplayNameChange: (name: string) => void;
	onImport: (params: {
		startSeconds: number;
		endSeconds: number;
		fadeInSeconds: number;
		fadeOutSeconds: number;
		playbackRate: number;
	}) => Promise<void>;
	isImporting: boolean;
	errorMessage?: string | null;
	/** Pre-fill values when re-editing an existing clip. */
	initialStartSeconds?: number;
	initialEndSeconds?: number;
	initialFadeIn?: number;
	initialFadeOut?: number;
	initialPlaybackRate?: number;
	/** Submit-button label, defaults to "Import". */
	submitLabel?: string;
	submittingLabel?: string;
}

interface WaveformPeaks {
	peaks: number[];
	duration: number;
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 10);
	return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

function clampValue(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

async function decodeWaveformPeaks(
	audioUrl: string,
	numPeaks: number,
): Promise<WaveformPeaks> {
	const response = await fetch(audioUrl);
	const arrayBuffer = await response.arrayBuffer();
	const audioContext = new AudioContext();
	try {
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		const channelData = audioBuffer.getChannelData(0);
		const totalSamples = channelData.length;
		const blockSize = Math.max(1, Math.floor(totalSamples / numPeaks));
		const peaks: number[] = [];
		for (let i = 0; i < numPeaks; i++) {
			let max = 0;
			const start = i * blockSize;
			const end = Math.min(start + blockSize, totalSamples);
			for (let j = start; j < end; j++) {
				const abs = Math.abs(channelData[j] ?? 0);
				if (abs > max) max = abs;
			}
			peaks.push(max);
		}
		return { peaks, duration: audioBuffer.duration };
	} finally {
		await audioContext.close();
	}
}

function drawWaveform(
	canvas: HTMLCanvasElement,
	peaks: number[],
	startFrac: number,
	endFrac: number,
	playFrac: number,
	isDark: boolean,
) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	const { width, height } = canvas;
	ctx.clearRect(0, 0, width, height);

	const midY = height / 2;
	const barWidth = width / peaks.length;

	// Draw bars
	for (let i = 0; i < peaks.length; i++) {
		const x = i * barWidth;
		const frac = i / peaks.length;
		const barH = Math.max(2, (peaks[i] ?? 0) * height * 0.85);

		let color: string;
		if (frac >= startFrac && frac < endFrac) {
			color = isDark ? "rgba(99,102,241,0.9)" : "rgba(79,70,229,0.85)";
		} else {
			color = isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)";
		}

		ctx.fillStyle = color;
		ctx.fillRect(x, midY - barH / 2, Math.max(1, barWidth - 0.5), barH);
	}

	// Draw playhead
	if (playFrac >= 0 && playFrac <= 1) {
		const px = playFrac * width;
		ctx.strokeStyle = isDark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.6)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(px, 0);
		ctx.lineTo(px, height);
		ctx.stroke();
	}

	// Draw start handle
	const sx = startFrac * width;
	ctx.fillStyle = "rgb(34,197,94)";
	ctx.fillRect(sx - 1, 0, 2, height);
	ctx.fillStyle = "rgb(34,197,94)";
	ctx.beginPath();
	ctx.moveTo(sx, 0);
	ctx.lineTo(sx + 8, 0);
	ctx.lineTo(sx, 10);
	ctx.closePath();
	ctx.fill();

	// Draw end handle
	const ex = endFrac * width;
	ctx.fillStyle = "rgb(239,68,68)";
	ctx.fillRect(ex - 1, 0, 2, height);
	ctx.fillStyle = "rgb(239,68,68)";
	ctx.beginPath();
	ctx.moveTo(ex, 0);
	ctx.lineTo(ex - 8, 0);
	ctx.lineTo(ex, 10);
	ctx.closePath();
	ctx.fill();
}

export function AudioEditor({
	tempId,
	videoTitle,
	thumbnailUrl,
	totalDuration,
	displayName,
	onDisplayNameChange,
	onImport,
	isImporting,
	errorMessage,
	initialStartSeconds,
	initialEndSeconds,
	initialFadeIn,
	initialFadeOut,
	initialPlaybackRate,
	submitLabel = "Import",
	submittingLabel = "Importing...",
}: AudioEditorProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const animFrameRef = useRef<number | null>(null);
	const previewStopRef = useRef<number | null>(null);
	const draggingRef = useRef<"start" | "end" | null>(null);

	const [waveform, setWaveform] = useState<WaveformPeaks | null>(null);
	const [waveformError, setWaveformError] = useState<string | null>(null);
	const [isLoadingWaveform, setIsLoadingWaveform] = useState(true);

	const [startSeconds, setStartSeconds] = useState(initialStartSeconds ?? 0);
	const [endSeconds, setEndSeconds] = useState(
		initialEndSeconds ?? Math.min(10, totalDuration),
	);
	const [playFrac, setPlayFrac] = useState(-1);
	const [isPlaying, setIsPlaying] = useState(false);
	const [fadeIn, setFadeIn] = useState(initialFadeIn ?? 0);
	const [fadeOut, setFadeOut] = useState(initialFadeOut ?? 0);
	const [playbackRate, setPlaybackRate] = useState(initialPlaybackRate ?? 1.0);
	const hasInitialRange =
		initialStartSeconds !== undefined && initialEndSeconds !== undefined;

	const nameId = useId();

	const audioUrl = `superset-temp-audio://${tempId}`;

	const rawDuration = endSeconds - startSeconds;
	const outputDuration = rawDuration / playbackRate;
	const outputValid = rawDuration > 0 && outputDuration <= MAX_OUTPUT_DURATION;

	const isDark =
		document.documentElement.classList.contains("dark") ||
		window.matchMedia("(prefers-color-scheme: dark)").matches;

	// Load waveform on mount. Peak count is generous so drawing stays crisp
	// even on wide dialogs / HiDPI displays; we downsample per draw if needed.
	useEffect(() => {
		let cancelled = false;
		setIsLoadingWaveform(true);
		setWaveformError(null);

		decodeWaveformPeaks(audioUrl, 2400)
			.then((data) => {
				if (!cancelled) {
					setWaveform(data);
					if (!hasInitialRange) {
						setStartSeconds(0);
						setEndSeconds(Math.min(10, data.duration));
					}
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setWaveformError(
						err instanceof Error ? err.message : "Failed to load audio",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setIsLoadingWaveform(false);
			});

		return () => {
			cancelled = true;
		};
	}, [audioUrl, hasInitialRange]);

	// Draw waveform whenever relevant state changes
	const redrawWaveform = useCallback(() => {
		if (!canvasRef.current || !waveform) return;
		const duration = waveform.duration || totalDuration;
		drawWaveform(
			canvasRef.current,
			waveform.peaks,
			startSeconds / duration,
			endSeconds / duration,
			playFrac,
			isDark,
		);
	}, [waveform, startSeconds, endSeconds, playFrac, totalDuration, isDark]);

	useEffect(() => {
		redrawWaveform();
	}, [redrawWaveform]);

	// Size the canvas backing store to match CSS pixels × DPR so the waveform
	// stays sharp when the dialog grows. Redraws on resize.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			const w = Math.max(1, Math.floor(rect.width * dpr));
			const h = Math.max(1, Math.floor(rect.height * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
				redrawWaveform();
			}
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [redrawWaveform]);

	// Animate playhead
	useEffect(() => {
		if (!isPlaying) {
			if (animFrameRef.current !== null) {
				cancelAnimationFrame(animFrameRef.current);
				animFrameRef.current = null;
			}
			return;
		}
		const duration = waveform?.duration || totalDuration;
		const tick = () => {
			const audio = audioRef.current;
			if (audio && duration > 0) {
				setPlayFrac(audio.currentTime / duration);
			}
			animFrameRef.current = requestAnimationFrame(tick);
		};
		animFrameRef.current = requestAnimationFrame(tick);
		return () => {
			if (animFrameRef.current !== null) {
				cancelAnimationFrame(animFrameRef.current);
				animFrameRef.current = null;
			}
		};
	}, [isPlaying, waveform, totalDuration]);

	const stopPreview = useCallback(() => {
		if (previewStopRef.current !== null) {
			clearInterval(previewStopRef.current);
			previewStopRef.current = null;
		}
		const audio = audioRef.current;
		if (audio) {
			audio.pause();
			audio.currentTime = startSeconds;
		}
		setIsPlaying(false);
		setPlayFrac(startSeconds / (waveform?.duration || totalDuration));
	}, [startSeconds, waveform, totalDuration]);

	const handleTogglePreview = useCallback(() => {
		const audio = audioRef.current;
		if (!audio) return;

		if (isPlaying) {
			stopPreview();
			return;
		}

		// Apply playback rate for preview
		audio.playbackRate = playbackRate;
		audio.currentTime = startSeconds;
		audio.play().catch(() => setIsPlaying(false));
		setIsPlaying(true);

		// Stop at end time
		if (previewStopRef.current !== null) {
			clearInterval(previewStopRef.current);
		}
		previewStopRef.current = window.setInterval(() => {
			const a = audioRef.current;
			if (!a) return;
			// currentTime in the source maps to effective time / playbackRate
			if (a.currentTime >= endSeconds) {
				stopPreview();
			}
		}, 50);
	}, [isPlaying, startSeconds, endSeconds, playbackRate, stopPreview]);

	// Stop preview when selection changes
	const isPlayingRef = useRef(isPlaying);
	isPlayingRef.current = isPlaying;
	// biome-ignore lint/correctness/useExhaustiveDependencies: isPlaying tracked via ref to avoid stopping on play-start
	useEffect(() => {
		if (isPlayingRef.current) stopPreview();
	}, [startSeconds, endSeconds, stopPreview]);

	const handleCanvasMouseDown = useCallback(
		(e: React.MouseEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (!canvas || !waveform) return;
			const rect = canvas.getBoundingClientRect();
			const x = e.clientX - rect.left;
			const duration = waveform.duration || totalDuration;
			const totalWidth = rect.width;

			const sx = (startSeconds / duration) * totalWidth;
			const ex = (endSeconds / duration) * totalWidth;

			const distStart = Math.abs(x - sx);
			const distEnd = Math.abs(x - ex);

			if (distStart <= 10 && distStart <= distEnd) {
				draggingRef.current = "start";
			} else if (distEnd <= 10) {
				draggingRef.current = "end";
			} else {
				// Click to seek
				const time = clampValue((x / totalWidth) * duration, 0, duration);
				if (audioRef.current) audioRef.current.currentTime = time;
				setPlayFrac(time / duration);
			}
		},
		[waveform, startSeconds, endSeconds, totalDuration],
	);

	const handleCanvasMouseMove = useCallback(
		(e: React.MouseEvent<HTMLCanvasElement>) => {
			if (!draggingRef.current || !waveform) return;
			const canvas = canvasRef.current;
			if (!canvas) return;
			const rect = canvas.getBoundingClientRect();
			const x = e.clientX - rect.left;
			const duration = waveform.duration || totalDuration;
			const time = clampValue((x / rect.width) * duration, 0, duration);

			if (draggingRef.current === "start") {
				setStartSeconds(Math.min(time, endSeconds - 0.5));
			} else {
				setEndSeconds(Math.max(time, startSeconds + 0.5));
			}
		},
		[waveform, startSeconds, endSeconds, totalDuration],
	);

	const handleCanvasMouseUp = useCallback(() => {
		draggingRef.current = null;
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (previewStopRef.current !== null) {
				clearInterval(previewStopRef.current);
			}
			if (animFrameRef.current !== null) {
				cancelAnimationFrame(animFrameRef.current);
			}
			audioRef.current?.pause();
		};
	}, []);

	const handleStartInput = (val: string) => {
		const n = Number.parseFloat(val);
		if (!Number.isNaN(n)) {
			const duration = waveform?.duration || totalDuration;
			setStartSeconds(clampValue(n, 0, Math.min(endSeconds - 0.5, duration)));
		}
	};

	const handleEndInput = (val: string) => {
		const n = Number.parseFloat(val);
		if (!Number.isNaN(n)) {
			const duration = waveform?.duration || totalDuration;
			setEndSeconds(clampValue(n, Math.max(startSeconds + 0.5, 0), duration));
		}
	};

	const handleImport = async () => {
		await onImport({
			startSeconds,
			endSeconds,
			fadeInSeconds: fadeIn,
			fadeOutSeconds: fadeOut,
			playbackRate,
		});
	};

	const duration = waveform?.duration || totalDuration;

	return (
		<div className="space-y-4">
			{/* Video info */}
			<div className="flex items-center gap-3">
				{thumbnailUrl && (
					<img
						src={thumbnailUrl}
						alt=""
						className="w-16 h-10 object-cover rounded shrink-0"
					/>
				)}
				<div className="min-w-0">
					<p className="text-sm font-medium truncate">{videoTitle}</p>
					<p className="text-xs text-muted-foreground">
						{formatTime(duration)}
					</p>
				</div>
			</div>

			{/* Waveform */}
			<div className="space-y-1">
				{isLoadingWaveform ? (
					<div className="h-20 flex items-center justify-center bg-muted/30 rounded">
						<LuLoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : waveformError ? (
					<div className="h-20 flex items-center justify-center bg-muted/30 rounded">
						<p className="text-xs text-destructive">{waveformError}</p>
					</div>
				) : (
					<canvas
						ref={canvasRef}
						width={600}
						height={80}
						className="w-full h-20 rounded cursor-col-resize select-none"
						onMouseDown={handleCanvasMouseDown}
						onMouseMove={handleCanvasMouseMove}
						onMouseUp={handleCanvasMouseUp}
						onMouseLeave={handleCanvasMouseUp}
					/>
				)}
				<div className="flex justify-between text-xs text-muted-foreground">
					<span>{formatTime(0)}</span>
					<span className="text-primary text-xs font-medium">
						{formatTime(startSeconds)} → {formatTime(endSeconds)}
					</span>
					<span>{formatTime(duration)}</span>
				</div>
			</div>

			{/* Start / End time inputs */}
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1">
					<Label className="text-xs">Start (sec)</Label>
					<Input
						type="number"
						min={0}
						max={duration}
						step={0.1}
						value={startSeconds.toFixed(1)}
						onChange={(e) => handleStartInput(e.target.value)}
						className="h-8 text-sm"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-xs">End (sec)</Label>
					<Input
						type="number"
						min={0}
						max={duration}
						step={0.1}
						value={endSeconds.toFixed(1)}
						onChange={(e) => handleEndInput(e.target.value)}
						className="h-8 text-sm"
					/>
				</div>
			</div>

			{/* Preview button */}
			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					variant={isPlaying ? "destructive" : "outline"}
					onClick={handleTogglePreview}
					disabled={isLoadingWaveform || !waveform}
					className="gap-1.5"
				>
					{isPlaying ? (
						<>
							<HiStop className="h-3.5 w-3.5" />
							Stop
						</>
					) : (
						<>
							<HiPlay className="h-3.5 w-3.5 ml-0.5" />
							Preview
						</>
					)}
				</Button>
				<span
					className={cn(
						"text-xs",
						outputValid ? "text-muted-foreground" : "text-destructive",
					)}
				>
					Output: {outputDuration.toFixed(1)}s / {MAX_OUTPUT_DURATION}s max
				</span>
			</div>

			{/* Fade in/out */}
			<div className="grid grid-cols-2 gap-4">
				<div className="space-y-2">
					<Label className="text-xs">Fade In: {fadeIn.toFixed(1)}s</Label>
					<Slider
						min={0}
						max={Math.min(5, rawDuration / 2)}
						step={0.1}
						value={[fadeIn]}
						onValueChange={([v]) => setFadeIn(v ?? 0)}
					/>
				</div>
				<div className="space-y-2">
					<Label className="text-xs">Fade Out: {fadeOut.toFixed(1)}s</Label>
					<Slider
						min={0}
						max={Math.min(5, rawDuration / 2)}
						step={0.1}
						value={[fadeOut]}
						onValueChange={([v]) => setFadeOut(v ?? 0)}
					/>
				</div>
			</div>

			{/* Playback speed */}
			<div className="space-y-2">
				<Label className="text-xs">
					Playback Speed: {playbackRate.toFixed(2)}x
					{playbackRate !== 1.0 && (
						<span className="text-muted-foreground ml-2">
							(notification will play at this speed)
						</span>
					)}
				</Label>
				<Slider
					min={-1}
					max={1}
					step={0.01}
					value={[Math.log2(playbackRate)]}
					onValueChange={([v]) => {
						const exp = v ?? 0;
						const rate = 2 ** exp;
						// Snap to 1.00x near center to make it easy to hit.
						setPlaybackRate(Math.abs(exp) < 0.02 ? 1.0 : rate);
					}}
				/>
				<div className="flex justify-between text-xs text-muted-foreground">
					<span>0.5x</span>
					<span>1x</span>
					<span>2x</span>
				</div>
			</div>

			{/* Display name */}
			<div className="space-y-1">
				<Label htmlFor={nameId} className="text-xs">
					Display name
				</Label>
				<Input
					id={nameId}
					type="text"
					placeholder={videoTitle}
					value={displayName}
					onChange={(e) => onDisplayNameChange(e.target.value)}
					maxLength={80}
					className="h-8 text-sm"
				/>
			</div>

			{errorMessage && (
				<p className="text-sm text-destructive break-words">{errorMessage}</p>
			)}

			{!outputValid && rawDuration > 0 && (
				<p className="text-xs text-destructive">
					Output duration ({outputDuration.toFixed(1)}s) exceeds{" "}
					{MAX_OUTPUT_DURATION}s. Shorten the selection or increase playback
					speed.
				</p>
			)}

			<Button
				type="button"
				className="w-full"
				disabled={!outputValid || isImporting || isLoadingWaveform}
				onClick={handleImport}
			>
				{isImporting && (
					<LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
				)}
				{isImporting ? submittingLabel : submitLabel}
			</Button>

			{/* biome-ignore lint/a11y/useMediaCaption: programmatic preview player, no dialogue content */}
			<audio ref={audioRef} src={audioUrl} preload="none" />
		</div>
	);
}
