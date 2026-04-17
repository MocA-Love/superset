import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";
import { access, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { getProcessEnvWithShellPath } from "lib/trpc/routers/workspaces/utils/shell-env";
import {
	type CustomRingtoneInfo,
	importCustomRingtoneFromPath,
	setCustomRingtoneDisplayName,
} from "./custom-ringtones";

const MAX_CLIP_DURATION_SECONDS = 30;
const YT_DLP_TIMEOUT_MS = 120_000;
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

export interface ImportFromYouTubeOptions {
	url: string;
	startSeconds: number;
	durationSeconds: number;
	displayName?: string;
}

export class YouTubeRingtoneError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "BINARY_MISSING"
			| "INVALID_URL"
			| "INVALID_RANGE"
			| "DOWNLOAD_FAILED"
			| "TIMEOUT",
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

function runYtDlp(
	ytDlpPath: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ytDlpPath, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(
				new YouTubeRingtoneError(
					"yt-dlp timed out while downloading the audio.",
					"TIMEOUT",
				),
			);
		}, YT_DLP_TIMEOUT_MS);

		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(
				new YouTubeRingtoneError(
					`Failed to launch yt-dlp: ${error.message}`,
					"DOWNLOAD_FAILED",
				),
			);
		});

		proc.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
			} else {
				const trimmed = stderr.trim().split("\n").slice(-3).join("\n");
				reject(
					new YouTubeRingtoneError(
						trimmed || `yt-dlp exited with code ${code ?? "?"}`,
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

export async function importRingtoneFromYouTube(
	options: ImportFromYouTubeOptions,
): Promise<CustomRingtoneInfo> {
	const url = options.url.trim();

	if (!isLikelyYouTubeUrl(url)) {
		throw new YouTubeRingtoneError(
			"Please enter a valid YouTube URL (youtube.com or youtu.be).",
			"INVALID_URL",
		);
	}

	const startSeconds = Math.max(0, Math.floor(options.startSeconds));
	const durationSeconds = Math.floor(options.durationSeconds);

	if (
		!Number.isFinite(durationSeconds) ||
		durationSeconds <= 0 ||
		durationSeconds > MAX_CLIP_DURATION_SECONDS
	) {
		throw new YouTubeRingtoneError(
			`Clip duration must be between 1 and ${MAX_CLIP_DURATION_SECONDS} seconds.`,
			"INVALID_RANGE",
		);
	}

	const shellEnv = await getProcessEnvWithShellPath();
	const resolved = await resolveRequiredBinaries(shellEnv);

	// Ensure the directory containing ffmpeg is on PATH for any child lookups
	// yt-dlp may do internally (defense in depth — we also pass --ffmpeg-location).
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
	const outputTemplate = join(workDir, "clip.%(ext)s");

	const endSeconds = startSeconds + durationSeconds;
	const sectionSpec = `*${startSeconds}-${endSeconds}`;

	const args = [
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

	try {
		await runYtDlp(resolved["yt-dlp"], args, workDir, spawnEnv);

		const producedPath = findProducedAudio(workDir);
		if (!producedPath) {
			throw new YouTubeRingtoneError(
				"yt-dlp did not produce an audio file. The video may be unavailable or restricted.",
				"DOWNLOAD_FAILED",
			);
		}

		const info = await importCustomRingtoneFromPath(producedPath);

		const displayName = options.displayName?.trim();
		if (displayName) {
			setCustomRingtoneDisplayName(displayName);
			return { ...info, name: displayName.slice(0, 80) };
		}

		return info;
	} finally {
		await safeUnlink(join(workDir, "clip.mp3"));
		await rm(workDir, { recursive: true, force: true }).catch(() => {
			// Best-effort cleanup.
		});
	}
}

async function safeUnlink(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// Best-effort cleanup.
	}
}

export const YOUTUBE_RINGTONE_LIMITS = {
	maxDurationSeconds: MAX_CLIP_DURATION_SECONDS,
};
