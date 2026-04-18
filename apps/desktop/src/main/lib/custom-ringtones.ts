import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { CUSTOM_RINGTONE_ID } from "shared/ringtones";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "./app-environment";

const RINGTONES_ASSETS_DIR = join(SUPERSET_HOME_DIR, "assets", "ringtones");
const CUSTOM_RINGTONE_FILE_STEM = "notification-custom";
const CUSTOM_RINGTONE_SOURCE_STEM = "notification-custom-source";
const CUSTOM_RINGTONE_METADATA_PATH = join(
	RINGTONES_ASSETS_DIR,
	`${CUSTOM_RINGTONE_FILE_STEM}.json`,
);
const MAX_CUSTOM_RINGTONE_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const ALLOWED_SOURCE_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".ogg",
	".m4a",
	".aac",
	".opus",
	".webm",
]);

export interface RingtoneEditState {
	startSeconds: number;
	endSeconds: number;
	fadeInSeconds?: number;
	fadeOutSeconds?: number;
	playbackRate?: number;
	sourceTitle?: string;
	sourceUrl?: string;
}

interface CustomRingtoneMetadata {
	name?: string;
	importedAt?: number;
	thumbnailUrl?: string;
	editState?: RingtoneEditState;
}

export interface CustomRingtoneInfo {
	id: string;
	name: string;
	description: string;
	emoji: string;
	thumbnailUrl?: string;
}

function isAllowedAudioExtension(filePath: string): boolean {
	return ALLOWED_AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function getCustomRingtoneFilename(): string | null {
	if (!existsSync(RINGTONES_ASSETS_DIR)) {
		return null;
	}

	const candidates = readdirSync(RINGTONES_ASSETS_DIR).filter((file) => {
		return (
			file.startsWith(`${CUSTOM_RINGTONE_FILE_STEM}.`) &&
			isAllowedAudioExtension(file)
		);
	});

	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((a, b) => {
		const aMtime = statSync(join(RINGTONES_ASSETS_DIR, a)).mtimeMs;
		const bMtime = statSync(join(RINGTONES_ASSETS_DIR, b)).mtimeMs;
		return bMtime - aMtime;
	});

	return candidates[0] ?? null;
}

function removeExistingCustomRingtoneFiles(): void {
	if (!existsSync(RINGTONES_ASSETS_DIR)) {
		return;
	}

	for (const file of readdirSync(RINGTONES_ASSETS_DIR)) {
		if (
			file.startsWith(`${CUSTOM_RINGTONE_FILE_STEM}.`) &&
			isAllowedAudioExtension(file)
		) {
			unlinkSync(join(RINGTONES_ASSETS_DIR, file));
		}
	}
}

function sanitizeDisplayName(filename: string): string {
	const stripped = filename.replace(/\.[^/.]+$/, "").trim();
	if (!stripped) {
		return "Custom Audio";
	}
	return stripped.slice(0, 80);
}

function normalizePathForComparison(filePath: string): string {
	const resolved = resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function areSamePath(pathA: string, pathB: string): boolean {
	return (
		normalizePathForComparison(pathA) === normalizePathForComparison(pathB)
	);
}

function readCustomRingtoneMetadata(): CustomRingtoneMetadata {
	if (!existsSync(CUSTOM_RINGTONE_METADATA_PATH)) {
		return {};
	}

	try {
		const raw = readFileSync(CUSTOM_RINGTONE_METADATA_PATH, "utf-8");
		const parsed = JSON.parse(raw) as CustomRingtoneMetadata;
		return parsed ?? {};
	} catch {
		return {};
	}
}

function writeCustomRingtoneMetadata(
	name: string,
	importedAt: number = Date.now(),
	thumbnailUrl?: string,
	editState?: RingtoneEditState,
): void {
	writeFileSync(
		CUSTOM_RINGTONE_METADATA_PATH,
		JSON.stringify({
			name,
			importedAt,
			...(thumbnailUrl ? { thumbnailUrl } : {}),
			...(editState ? { editState } : {}),
		}),
		"utf-8",
	);

	try {
		chmodSync(CUSTOM_RINGTONE_METADATA_PATH, SUPERSET_SENSITIVE_FILE_MODE);
	} catch {
		// Best effort only.
	}
}

function getCustomRingtoneSourceFilename(): string | null {
	if (!existsSync(RINGTONES_ASSETS_DIR)) return null;
	const candidates = readdirSync(RINGTONES_ASSETS_DIR).filter(
		(file) =>
			file.startsWith(`${CUSTOM_RINGTONE_SOURCE_STEM}.`) &&
			ALLOWED_SOURCE_EXTENSIONS.has(extname(file).toLowerCase()),
	);
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => {
		const am = statSync(join(RINGTONES_ASSETS_DIR, a)).mtimeMs;
		const bm = statSync(join(RINGTONES_ASSETS_DIR, b)).mtimeMs;
		return bm - am;
	});
	return candidates[0] ?? null;
}

export function getCustomRingtoneSourcePath(): string | null {
	const name = getCustomRingtoneSourceFilename();
	return name ? join(RINGTONES_ASSETS_DIR, name) : null;
}

function removeExistingSourceFiles(): void {
	if (!existsSync(RINGTONES_ASSETS_DIR)) return;
	for (const file of readdirSync(RINGTONES_ASSETS_DIR)) {
		if (file.startsWith(`${CUSTOM_RINGTONE_SOURCE_STEM}.`)) {
			try {
				unlinkSync(join(RINGTONES_ASSETS_DIR, file));
			} catch {
				// Best effort.
			}
		}
	}
}

export async function saveCustomRingtoneSource(
	sourcePath: string,
): Promise<string> {
	ensureCustomRingtonesDir();
	const ext = extname(sourcePath).toLowerCase();
	const dest = join(
		RINGTONES_ASSETS_DIR,
		`${CUSTOM_RINGTONE_SOURCE_STEM}${ext}`,
	);
	if (areSamePath(sourcePath, dest) && existsSync(dest)) {
		try {
			chmodSync(dest, SUPERSET_SENSITIVE_FILE_MODE);
		} catch {
			// Best effort.
		}
		return dest;
	}
	const tempPath = join(
		RINGTONES_ASSETS_DIR,
		`.tmp-${CUSTOM_RINGTONE_SOURCE_STEM}-${randomUUID()}${ext}`,
	);
	try {
		await copyFile(sourcePath, tempPath);
		removeExistingSourceFiles();
		await rename(tempPath, dest);
	} catch (error) {
		if (existsSync(tempPath)) {
			try {
				await unlink(tempPath);
			} catch {
				// Best effort cleanup only.
			}
		}
		throw error;
	}
	try {
		chmodSync(dest, SUPERSET_SENSITIVE_FILE_MODE);
	} catch {
		// Best effort.
	}
	return dest;
}

export function getCustomRingtoneEditState(): RingtoneEditState | null {
	return readCustomRingtoneMetadata().editState ?? null;
}

export function updateCustomRingtoneEditState(
	editState: RingtoneEditState,
): void {
	const existing = readCustomRingtoneMetadata();
	writeCustomRingtoneMetadata(
		existing.name ?? "Custom Audio",
		existing.importedAt ?? Date.now(),
		existing.thumbnailUrl,
		editState,
	);
}

export function ensureCustomRingtonesDir(): void {
	if (!existsSync(RINGTONES_ASSETS_DIR)) {
		mkdirSync(RINGTONES_ASSETS_DIR, {
			recursive: true,
			mode: SUPERSET_HOME_DIR_MODE,
		});
	}

	try {
		chmodSync(RINGTONES_ASSETS_DIR, SUPERSET_HOME_DIR_MODE);
	} catch {
		// Best effort only.
	}
}

export function hasCustomRingtone(): boolean {
	return getCustomRingtoneFilename() !== null;
}

export function getCustomRingtonePath(): string | null {
	const filename = getCustomRingtoneFilename();
	if (!filename) {
		return null;
	}
	return join(RINGTONES_ASSETS_DIR, filename);
}

export function deleteCustomRingtone(): void {
	if (!existsSync(RINGTONES_ASSETS_DIR)) {
		return;
	}
	removeExistingCustomRingtoneFiles();
	removeExistingSourceFiles();
	if (existsSync(CUSTOM_RINGTONE_METADATA_PATH)) {
		try {
			unlinkSync(CUSTOM_RINGTONE_METADATA_PATH);
		} catch {
			// Best effort.
		}
	}
}

export function setCustomRingtoneDisplayName(name: string): void {
	if (!hasCustomRingtone()) {
		return;
	}
	ensureCustomRingtonesDir();
	const displayName = name.trim().slice(0, 80) || "Custom Audio";
	const existing = readCustomRingtoneMetadata();
	writeCustomRingtoneMetadata(
		displayName,
		existing.importedAt ?? Date.now(),
		existing.thumbnailUrl,
	);
}

export function getCustomRingtoneInfo(): CustomRingtoneInfo | null {
	if (!hasCustomRingtone()) {
		return null;
	}

	const metadata = readCustomRingtoneMetadata();

	return {
		id: CUSTOM_RINGTONE_ID,
		name: metadata.name?.trim() || "Custom Audio",
		description: "Imported from your local machine",
		emoji: "SFX",
		...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
	};
}

export interface ImportOptions {
	displayName?: string;
	thumbnailUrl?: string;
}

export async function importCustomRingtoneFromPath(
	sourcePath: string,
	options?: ImportOptions,
): Promise<CustomRingtoneInfo> {
	if (!isAllowedAudioExtension(sourcePath)) {
		throw new Error("Only .mp3, .wav, and .ogg files are supported");
	}

	const sourceStat = statSync(sourcePath);
	if (!sourceStat.isFile()) {
		throw new Error("Selected path is not a file");
	}

	if (sourceStat.size > MAX_CUSTOM_RINGTONE_SIZE_BYTES) {
		throw new Error(
			`Audio file is too large (${Math.round(sourceStat.size / 1024 / 1024)}MB). Maximum is 20MB.`,
		);
	}

	ensureCustomRingtonesDir();

	const ext = extname(sourcePath).toLowerCase();
	const destinationPath = join(
		RINGTONES_ASSETS_DIR,
		`${CUSTOM_RINGTONE_FILE_STEM}${ext}`,
	);
	const displayName =
		options?.displayName?.trim().slice(0, 80) ||
		sanitizeDisplayName(basename(sourcePath));
	const thumbnailUrl = options?.thumbnailUrl;

	// Re-importing the same file path should not delete the active ringtone.
	if (areSamePath(sourcePath, destinationPath) && existsSync(destinationPath)) {
		try {
			chmodSync(destinationPath, SUPERSET_SENSITIVE_FILE_MODE);
		} catch {
			// Best effort only.
		}
		writeCustomRingtoneMetadata(displayName, Date.now(), thumbnailUrl);
		return {
			id: CUSTOM_RINGTONE_ID,
			name: displayName,
			description: "Imported from your local machine",
			emoji: "SFX",
			...(thumbnailUrl ? { thumbnailUrl } : {}),
		};
	}

	const tempPath = join(
		RINGTONES_ASSETS_DIR,
		`.tmp-${CUSTOM_RINGTONE_FILE_STEM}-${randomUUID()}${ext}`,
	);

	try {
		// Copy first so existing ringtone remains intact if this step fails.
		await copyFile(sourcePath, tempPath);
		removeExistingCustomRingtoneFiles();
		await rename(tempPath, destinationPath);
	} catch (error) {
		if (existsSync(tempPath)) {
			try {
				await unlink(tempPath);
			} catch {
				// Best effort cleanup only.
			}
		}
		throw error;
	}

	try {
		chmodSync(destinationPath, SUPERSET_SENSITIVE_FILE_MODE);
	} catch {
		// Best effort only.
	}

	writeCustomRingtoneMetadata(displayName, Date.now(), thumbnailUrl);

	return {
		id: CUSTOM_RINGTONE_ID,
		name: displayName,
		description: "Imported from your local machine",
		emoji: "SFX",
		...(thumbnailUrl ? { thumbnailUrl } : {}),
	};
}
