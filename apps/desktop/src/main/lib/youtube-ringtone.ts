import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
	setCustomRingtoneDisplayName,
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
const ALLOWED_OUTPUT_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);

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

export async function installMissingBinaries(): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error(
			"Auto-install is only supported on macOS. Please install yt-dlp and ffmpeg manually.",
		);
	}

	const shellEnv = await getProcessEnvWithShellPath();
	const brewPath = await resolveBinaryPath("brew", shellEnv);
	if (!brewPath) {
		throw new Error(
			"Homebrew is not installed. Please install it from https://brew.sh and then install yt-dlp and ffmpeg.",
		);
	}

	await new Promise<void>((resolve, reject) => {
		const proc = spawn(brewPath, ["install", "yt-dlp", "ffmpeg"], {
			env: shellEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("Installation timed out after 10 minutes."));
		}, 600_000);

		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
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
				const msg = stderr.trim().split("\n").slice(-3).join("\n");
				reject(
					new Error(msg || `brew install exited with code ${code ?? "?"}`),
				);
			}
		});
	});
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

	const infoArgs = [
		"--dump-single-json",
		"--no-playlist",
		"--no-warnings",
		`--match-filter`,
		`duration <= ${MAX_FULL_DOWNLOAD_DURATION_SECONDS}`,
		trimmedUrl,
	];

	let info: VideoInfo;
	try {
		const jsonOutput = await runProcess(
			resolved["yt-dlp"],
			infoArgs,
			workDir,
			spawnEnv,
			YT_DLP_TIMEOUT_MS,
		);
		const data = JSON.parse(jsonOutput) as {
			title?: string;
			duration?: number;
			thumbnail?: string;
		};
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

	const downloadArgs = [
		"--no-playlist",
		"--no-warnings",
		"--quiet",
		"-x",
		"--audio-format",
		"mp3",
		"--audio-quality",
		"5",
		"--ffmpeg-location",
		ffmpegDir,
		"-o",
		outputTemplate,
		trimmedUrl,
	];

	try {
		await runProcess(
			resolved["yt-dlp"],
			downloadArgs,
			workDir,
			spawnEnv,
			FULL_DOWNLOAD_TIMEOUT_MS,
		);
	} catch (err) {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
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
		const ffmpegArgs: string[] = ["-i", inputPath];

		if (options.tempFilePath) {
			// Trim from the full downloaded file
			ffmpegArgs.push("-ss", String(startSeconds), "-to", String(endSeconds));
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

		return await importCustomRingtoneFromPath(outputPath, {
			displayName: options.displayName?.trim() || undefined,
			thumbnailUrl: options.thumbnailUrl,
		});
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

export { setCustomRingtoneDisplayName };

export const YOUTUBE_RINGTONE_LIMITS = {
	maxDurationSeconds: MAX_CLIP_DURATION_SECONDS,
	maxFullDownloadDurationSeconds: MAX_FULL_DOWNLOAD_DURATION_SECONDS,
};
