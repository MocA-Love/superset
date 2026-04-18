import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { getProcessEnvWithShellPath } from "lib/trpc/routers/workspaces/utils/shell-env";
import {
	type CustomRingtoneInfo,
	importCustomRingtoneFromPath,
	saveCustomRingtoneSource,
	setCustomRingtoneDisplayName,
	updateCustomRingtoneEditState,
} from "./custom-ringtones";
import {
	getTempAudioPath,
	registerTempAudio,
	unregisterTempAudio,
} from "./temp-audio-protocol";

const MAX_CLIP_DURATION_SECONDS = 30;
const YT_DLP_TIMEOUT_MS = 120_000;
const FULL_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FULL_DOWNLOAD_DURATION_SECONDS = 600;
const REQUIRED_BINARIES = ["yt-dlp", "ffmpeg", "ffprobe"] as const;
type RequiredBinary = (typeof REQUIRED_BINARIES)[number];
const ALLOWED_OUTPUT_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".ogg",
	".m4a",
	".aac",
	".opus",
	".webm",
]);

const FALLBACK_SEARCH_DIRS = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/local/sbin",
	"/usr/bin",
	"/usr/sbin",
	"/bin",
	"/sbin",
];

export interface VideoInfo {
	title: string;
	thumbnailUrl: string;
	durationSeconds: number;
}

export interface DownloadedAudio {
	tempId: string;
	tempPath: string;
	info: VideoInfo;
}

export interface ImportFromYouTubeOptions {
	url: string;
	startSeconds: number;
	endSeconds: number;
	displayName?: string;
	thumbnailUrl?: string;
	fadeInSeconds?: number;
	fadeOutSeconds?: number;
	playbackRate?: number;
	/** If provided, skip yt-dlp download and use this temp file instead */
	tempFilePath?: string;
	/** Original video title (YouTube). Stored so re-edit can show it in the UI. */
	sourceTitle?: string;
}

export class YouTubeRingtoneError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "BINARY_MISSING"
			| "INVALID_URL"
			| "INVALID_RANGE"
			| "DOWNLOAD_FAILED"
			| "TIMEOUT"
			| "VIDEO_TOO_LONG",
	) {
		super(message);
		this.name = "YouTubeRingtoneError";
	}
}

const YOUTUBE_URL_PATTERN =
	/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)[\w-]+|youtu\.be\/[\w-]+)/i;

export function isLikelyYouTubeUrl(url: string): boolean {
	return YOUTUBE_URL_PATTERN.test(url.trim());
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

async function resolveBinaryPath(
	binary: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const searchDirs = new Set<string>();
	const pathEnv = env.PATH ?? env.Path ?? "";
	for (const dir of pathEnv.split(delimiter)) {
		if (dir) searchDirs.add(dir);
	}
	if (process.platform === "darwin" || process.platform === "linux") {
		for (const dir of FALLBACK_SEARCH_DIRS) searchDirs.add(dir);
	}

	for (const dir of searchDirs) {
		const candidate = join(dir, binary);
		if (await isExecutable(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function resolveRequiredBinaries(
	env: NodeJS.ProcessEnv,
): Promise<Record<RequiredBinary, string>> {
	const entries = await Promise.all(
		REQUIRED_BINARIES.map(async (bin) => {
			const path = await resolveBinaryPath(bin, env);
			return [bin, path] as const;
		}),
	);

	const missing = entries.filter(([, p]) => !p).map(([name]) => name);
	if (missing.length > 0) {
		const brewTargets =
			missing.filter((b) => b !== "ffprobe").join(" ") || "yt-dlp ffmpeg";
		throw new YouTubeRingtoneError(
			`Missing required tool(s): ${missing.join(", ")}. Install with \`brew install ${brewTargets}\` (macOS, ffprobe ships with ffmpeg) or your platform's package manager. If already installed, make sure it is on your login-shell PATH.`,
			"BINARY_MISSING",
		);
	}

	const resolved = Object.fromEntries(entries) as Record<
		RequiredBinary,
		string
	>;
	return resolved;
}

export async function checkMissingBinaries(): Promise<string[]> {
	const shellEnv = await getProcessEnvWithShellPath();
	const entries = await Promise.all(
		REQUIRED_BINARIES.map(async (bin) => {
			const path = await resolveBinaryPath(bin, shellEnv);
			return [bin, path] as const;
		}),
	);
	return entries.filter(([, p]) => !p).map(([name]) => name);
}

interface InstallEventBase {
	installId: string;
	seq: number;
	time: number;
}

export type InstallProgressEvent =
	| (InstallEventBase & {
			type: "log";
			message: string;
			level: "info" | "warn" | "error";
			stream: "stdout" | "stderr" | "system";
	  })
	| (InstallEventBase & { type: "done" })
	| (InstallEventBase & { type: "error"; message: string });

const installEventBus = new EventEmitter();
installEventBus.setMaxListeners(0);

const installEventBuffers = new Map<string, InstallProgressEvent[]>();
const installBufferEvictTimers = new Map<string, NodeJS.Timeout>();
const installSeqCounters = new Map<string, number>();
const INSTALL_MAX_BUFFERED_EVENTS = 1000;
const INSTALL_TERMINAL_EVICT_MS = 30_000;

function isTerminalInstallEvent(event: InstallProgressEvent): boolean {
	return event.type === "done" || event.type === "error";
}

function nextInstallSeq(installId: string): number {
	const next = (installSeqCounters.get(installId) ?? 0) + 1;
	installSeqCounters.set(installId, next);
	return next;
}

type DistributiveOmit<
	T,
	K extends keyof InstallProgressEvent,
> = T extends unknown ? Omit<T, K> : never;
type InstallEventInput = DistributiveOmit<InstallProgressEvent, "seq">;

function emitInstallEvent(input: InstallEventInput): void {
	const event = {
		...input,
		seq: nextInstallSeq(input.installId),
	} as InstallProgressEvent;
	let buffer = installEventBuffers.get(event.installId);
	if (!buffer) {
		buffer = [];
		installEventBuffers.set(event.installId, buffer);
	}
	buffer.push(event);
	if (buffer.length > INSTALL_MAX_BUFFERED_EVENTS) {
		buffer.splice(0, buffer.length - INSTALL_MAX_BUFFERED_EVENTS);
	}
	installEventBus.emit(event.installId, event);

	if (isTerminalInstallEvent(event)) {
		const existing = installBufferEvictTimers.get(event.installId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			installEventBuffers.delete(event.installId);
			installBufferEvictTimers.delete(event.installId);
			installSeqCounters.delete(event.installId);
		}, INSTALL_TERMINAL_EVICT_MS);
		installBufferEvictTimers.set(event.installId, timer);
	}
}

function emitInstallLog(
	installId: string,
	message: string,
	level: "info" | "warn" | "error",
	stream: "stdout" | "stderr" | "system",
): void {
	for (const line of message.split(/\r?\n/)) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		emitInstallEvent({
			type: "log",
			installId,
			time: Date.now(),
			message: trimmed,
			level,
			stream,
		});
	}
}

export function subscribeInstallEvents(
	installId: string,
	listener: (event: InstallProgressEvent) => void,
): () => void {
	installEventBus.on(installId, listener);
	return () => installEventBus.off(installId, listener);
}

export function getBufferedInstallEvents(
	installId: string,
): InstallProgressEvent[] {
	return installEventBuffers.get(installId)?.slice() ?? [];
}

export async function installMissingBinaries(installId: string): Promise<void> {
	if (process.platform !== "darwin") {
		const msg =
			"Auto-install is only supported on macOS. Please install yt-dlp and ffmpeg manually.";
		emitInstallLog(installId, msg, "error", "system");
		emitInstallEvent({
			type: "error",
			installId,
			time: Date.now(),
			message: msg,
		});
		throw new Error(msg);
	}

	emitInstallLog(installId, "Resolving Homebrew path…", "info", "system");
	const shellEnv = await getProcessEnvWithShellPath();
	const brewPath = await resolveBinaryPath("brew", shellEnv);
	if (!brewPath) {
		const msg =
			"Homebrew is not installed. Please install it from https://brew.sh and then install yt-dlp and ffmpeg.";
		emitInstallLog(installId, msg, "error", "system");
		emitInstallEvent({
			type: "error",
			installId,
			time: Date.now(),
			message: msg,
		});
		throw new Error(msg);
	}

	emitInstallLog(
		installId,
		`$ ${brewPath} install yt-dlp ffmpeg`,
		"info",
		"system",
	);

	try {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(brewPath, ["install", "yt-dlp", "ffmpeg"], {
				env: shellEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const timer = setTimeout(() => {
				proc.kill("SIGKILL");
				reject(new Error("Installation timed out after 10 minutes."));
			}, 600_000);

			let stderrTail = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				emitInstallLog(installId, chunk.toString(), "info", "stdout");
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				stderrTail = (stderrTail + text).split("\n").slice(-20).join("\n");
				// brew writes progress banners to stderr; show as info by default
				emitInstallLog(installId, text, "info", "stderr");
			});

			proc.on("error", (err) => {
				clearTimeout(timer);
				reject(new Error(`Failed to run brew: ${err.message}`));
			});

			proc.on("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) {
					resolve();
				} else {
					const msg = stderrTail.trim().split("\n").slice(-3).join("\n");
					reject(
						new Error(msg || `brew install exited with code ${code ?? "?"}`),
					);
				}
			});
		});

		emitInstallLog(installId, "Installation complete.", "info", "system");
		emitInstallEvent({ type: "done", installId, time: Date.now() });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		emitInstallLog(installId, message, "error", "system");
		emitInstallEvent({
			type: "error",
			installId,
			time: Date.now(),
			message,
		});
		throw err;
	}
}

function runProcess(
	binaryPath: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(binaryPath, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new YouTubeRingtoneError("Process timed out.", "TIMEOUT"));
		}, timeoutMs);

		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(
				new YouTubeRingtoneError(
					`Failed to launch process: ${error.message}`,
					"DOWNLOAD_FAILED",
				),
			);
		});

		proc.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				const trimmed = stderr.trim().split("\n").slice(-3).join("\n");
				reject(
					new YouTubeRingtoneError(
						trimmed || `Process exited with code ${code ?? "?"}`,
						"DOWNLOAD_FAILED",
					),
				);
			}
		});
	});
}

function findProducedAudio(workDir: string): string | null {
	if (!existsSync(workDir)) return null;
	const candidates = readdirSync(workDir)
		.filter((name) =>
			ALLOWED_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase()),
		)
		.map((name) => join(workDir, name))
		.filter((p) => {
			try {
				return statSync(p).isFile() && statSync(p).size > 0;
			} catch {
				return false;
			}
		});

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return candidates[0] ?? null;
}

export async function fetchYouTubeVideoInfo(url: string): Promise<VideoInfo> {
	const trimmedUrl = url.trim();
	if (!isLikelyYouTubeUrl(trimmedUrl)) {
		throw new YouTubeRingtoneError(
			"Please enter a valid YouTube URL (youtube.com or youtu.be).",
			"INVALID_URL",
		);
	}

	const shellEnv = await getProcessEnvWithShellPath();
	const resolved = await resolveRequiredBinaries(shellEnv);

	const workDir = join(tmpdir(), `superset-ytinfo-${randomUUID()}`);
	mkdirSync(workDir, { recursive: true });

	try {
		const jsonOutput = await runProcess(
			resolved["yt-dlp"],
			["--dump-single-json", "--no-playlist", "--no-warnings", trimmedUrl],
			workDir,
			shellEnv,
			YT_DLP_TIMEOUT_MS,
		);

		const data = JSON.parse(jsonOutput) as {
			title?: string;
			duration?: number;
			thumbnail?: string;
		};

		return {
			title: data.title?.trim() || "YouTube Video",
			thumbnailUrl: data.thumbnail || "",
			durationSeconds: data.duration ?? 0,
		};
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function downloadFullYouTubeAudio(
	url: string,
): Promise<DownloadedAudio> {
	const trimmedUrl = url.trim();
	if (!isLikelyYouTubeUrl(trimmedUrl)) {
		throw new YouTubeRingtoneError(
			"Please enter a valid YouTube URL (youtube.com or youtu.be).",
			"INVALID_URL",
		);
	}

	const shellEnv = await getProcessEnvWithShellPath();
	const resolved = await resolveRequiredBinaries(shellEnv);

	const ffmpegDir = dirname(resolved.ffmpeg);
	const existingPath = shellEnv.PATH ?? shellEnv.Path ?? "";
	const pathEntries = existingPath.split(delimiter).filter(Boolean);
	if (!pathEntries.includes(ffmpegDir)) {
		pathEntries.unshift(ffmpegDir);
	}
	const spawnEnv: NodeJS.ProcessEnv = {
		...shellEnv,
		PATH: pathEntries.join(delimiter),
	};

	const workDir = join(tmpdir(), `superset-ytfull-${randomUUID()}`);
	mkdirSync(workDir, { recursive: true });
	const outputTemplate = join(workDir, "audio.%(ext)s");

	// Single yt-dlp invocation: fetch metadata AND download the audio-only
	// stream. Skipping `-x --audio-format mp3` avoids a multi-second ffmpeg
	// re-encode — the browser and ffmpeg both decode m4a/webm natively, and
	// we can re-encode to mp3 only at the final import step.
	const args = [
		"--no-playlist",
		"--no-warnings",
		"--match-filter",
		`duration <= ${MAX_FULL_DOWNLOAD_DURATION_SECONDS}`,
		"-f",
		"bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
		"--concurrent-fragments",
		"5",
		"--ffmpeg-location",
		ffmpegDir,
		"--print-json",
		"--no-simulate",
		"-o",
		outputTemplate,
		trimmedUrl,
	];

	let info: VideoInfo;
	try {
		const jsonOutput = await runProcess(
			resolved["yt-dlp"],
			args,
			workDir,
			spawnEnv,
			FULL_DOWNLOAD_TIMEOUT_MS,
		);
		// --print-json can emit multiple JSON lines; find the one with title.
		const lastJsonLine = jsonOutput
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("{") && l.endsWith("}"))
			.pop();
		const data = lastJsonLine
			? (JSON.parse(lastJsonLine) as {
					title?: string;
					duration?: number;
					thumbnail?: string;
				})
			: {};
		info = {
			title: data.title?.trim() || "YouTube Video",
			thumbnailUrl: data.thumbnail || "",
			durationSeconds: data.duration ?? 0,
		};
	} catch (err) {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
		if (err instanceof YouTubeRingtoneError && err.code === "DOWNLOAD_FAILED") {
			const msg = err.message.toLowerCase();
			if (msg.includes("does not pass filter") || msg.includes("duration")) {
				throw new YouTubeRingtoneError(
					`Video is too long. Maximum supported duration is ${MAX_FULL_DOWNLOAD_DURATION_SECONDS / 60} minutes.`,
					"VIDEO_TOO_LONG",
				);
			}
		}
		throw err;
	}

	const producedPath = findProducedAudio(workDir);
	if (!producedPath) {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
		throw new YouTubeRingtoneError(
			"yt-dlp did not produce an audio file. The video may be unavailable or restricted.",
			"DOWNLOAD_FAILED",
		);
	}

	const tempId = randomUUID();
	registerTempAudio(tempId, producedPath);

	return { tempId, tempPath: producedPath, info };
}

export async function cleanupTempAudio(tempId: string): Promise<void> {
	const filePath = getTempAudioPath(tempId);
	unregisterTempAudio(tempId);
	if (filePath) {
		const dir = dirname(filePath);
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function importRingtoneFromYouTube(
	options: ImportFromYouTubeOptions,
): Promise<CustomRingtoneInfo> {
	const url = options.url.trim();

	if (!options.tempFilePath && !isLikelyYouTubeUrl(url)) {
		throw new YouTubeRingtoneError(
			"Please enter a valid YouTube URL (youtube.com or youtu.be).",
			"INVALID_URL",
		);
	}

	const startSeconds = Math.max(0, options.startSeconds);
	const endSeconds = options.endSeconds;
	const playbackRate = Math.max(
		0.5,
		Math.min(2.0, options.playbackRate ?? 1.0),
	);
	const rawDuration = endSeconds - startSeconds;
	const outputDuration = rawDuration / playbackRate;

	if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
		throw new YouTubeRingtoneError(
			"End time must be greater than start time.",
			"INVALID_RANGE",
		);
	}

	if (outputDuration > MAX_CLIP_DURATION_SECONDS) {
		throw new YouTubeRingtoneError(
			`Output clip duration (${outputDuration.toFixed(1)}s) exceeds the maximum of ${MAX_CLIP_DURATION_SECONDS} seconds.`,
			"INVALID_RANGE",
		);
	}

	const shellEnv = await getProcessEnvWithShellPath();
	const resolved = await resolveRequiredBinaries(shellEnv);

	const ffmpegDir = dirname(resolved.ffmpeg);
	const existingPath = shellEnv.PATH ?? shellEnv.Path ?? "";
	const pathEntries = existingPath.split(delimiter).filter(Boolean);
	if (!pathEntries.includes(ffmpegDir)) {
		pathEntries.unshift(ffmpegDir);
	}
	const spawnEnv: NodeJS.ProcessEnv = {
		...shellEnv,
		PATH: pathEntries.join(delimiter),
	};

	const workDir = join(tmpdir(), `superset-yt-${randomUUID()}`);
	mkdirSync(workDir, { recursive: true });

	try {
		let inputPath: string;

		if (options.tempFilePath) {
			inputPath = options.tempFilePath;
		} else {
			// Legacy: download section via yt-dlp
			const outputTemplate = join(workDir, "clip.%(ext)s");

			const sectionSpec = `*${startSeconds}-${endSeconds}`;
			const ytArgs = [
				"--no-playlist",
				"--no-warnings",
				"--quiet",
				"-x",
				"--audio-format",
				"mp3",
				"--audio-quality",
				"5",
				"--download-sections",
				sectionSpec,
				"--force-keyframes-at-cuts",
				"--ffmpeg-location",
				ffmpegDir,
				"-o",
				outputTemplate,
				url,
			];

			await runProcess(
				resolved["yt-dlp"],
				ytArgs,
				workDir,
				spawnEnv,
				YT_DLP_TIMEOUT_MS,
			);

			const downloaded = findProducedAudio(workDir);
			if (!downloaded) {
				throw new YouTubeRingtoneError(
					"yt-dlp did not produce an audio file. The video may be unavailable or restricted.",
					"DOWNLOAD_FAILED",
				);
			}
			inputPath = downloaded;
		}

		// Build ffmpeg filter chain
		const filters: string[] = [];
		if (playbackRate !== 1.0) {
			filters.push(`atempo=${playbackRate.toFixed(3)}`);
		}
		const fadeIn = options.fadeInSeconds ?? 0;
		const fadeOut = options.fadeOutSeconds ?? 0;
		if (fadeIn > 0) {
			filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
		}
		if (fadeOut > 0) {
			const fadeOutStart = Math.max(0, outputDuration - fadeOut);
			filters.push(
				`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`,
			);
		}

		const outputPath = join(workDir, `output_${randomUUID()}.mp3`);
		const ffmpegArgs: string[] = [];

		if (options.tempFilePath) {
			// Input-side seek: ffmpeg is fast AND frame-accurate, and it skips
			// MP3 decoder priming so the cut lines up with the browser preview.
			ffmpegArgs.push("-ss", startSeconds.toFixed(3));
		}

		ffmpegArgs.push("-i", inputPath);

		if (options.tempFilePath) {
			ffmpegArgs.push("-t", rawDuration.toFixed(3));
		}

		if (filters.length > 0) {
			ffmpegArgs.push("-af", filters.join(","));
		}

		ffmpegArgs.push("-acodec", "libmp3lame", "-q:a", "5", "-y", outputPath);

		await runProcess(
			resolved.ffmpeg,
			ffmpegArgs,
			workDir,
			spawnEnv,
			YT_DLP_TIMEOUT_MS,
		);

		const result = await importCustomRingtoneFromPath(outputPath, {
			displayName: options.displayName?.trim() || undefined,
			thumbnailUrl: options.thumbnailUrl,
		});

		// Persist the source audio + edit parameters so the user can re-open
		// the clip editor later and adjust the trim/fade/speed without
		// re-downloading from YouTube.
		if (options.tempFilePath) {
			try {
				await saveCustomRingtoneSource(options.tempFilePath);
				updateCustomRingtoneEditState({
					startSeconds,
					endSeconds,
					fadeInSeconds: options.fadeInSeconds,
					fadeOutSeconds: options.fadeOutSeconds,
					playbackRate,
					sourceTitle: options.sourceTitle,
					sourceUrl: options.url,
				});
			} catch (err) {
				console.error("Failed to persist ringtone source for re-edit:", err);
			}
		}

		return result;
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

export { setCustomRingtoneDisplayName };

export const YOUTUBE_RINGTONE_LIMITS = {
	maxDurationSeconds: MAX_CLIP_DURATION_SECONDS,
	maxFullDownloadDurationSeconds: MAX_FULL_DOWNLOAD_DURATION_SECONDS,
};
