import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "@superset/local-db";
import { localDb } from "../local-db";
import { playSoundFile } from "../play-sound";

export type AivisEventKind = "complete" | "permission";

export interface AivisPlaceholders {
	branch?: string;
	workspace?: string;
	worktree?: string;
	project?: string;
	tab?: string;
	pane?: string;
	event?: string;
}

const AIVIS_ENDPOINT = "https://api.aivis-project.com/v1/tts/synthesize";

export const AIVIS_PLACEHOLDER_KEYS = [
	"branch",
	"workspace",
	"worktree",
	"project",
	"tab",
	"pane",
	"event",
] as const satisfies readonly (keyof AivisPlaceholders)[];

export function renderAivisTemplate(
	template: string,
	vars: AivisPlaceholders,
): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
		const value = vars[key as keyof AivisPlaceholders];
		return value ?? "";
	});
}

function readAivisSettings() {
	try {
		const row = localDb.select().from(settings).get();
		return {
			enabled: row?.aivisEnabled ?? false,
			apiKey: row?.aivisApiKey ?? "",
			modelUuid: row?.aivisModelUuid ?? "",
			userDictionaryUuid: row?.aivisUserDictionaryUuid ?? "",
			format: row?.aivisFormat ?? "ワークスペース、{{workspace}}、です",
			formatPermission:
				row?.aivisFormatPermission ?? "{{branch}}で対応が必要です",
			volume:
				typeof row?.aivisVolume === "number" && Number.isFinite(row.aivisVolume)
					? Math.max(0, Math.min(100, row.aivisVolume))
					: 100,
			speakingRate:
				typeof row?.aivisSpeakingRate === "number" &&
				Number.isFinite(row.aivisSpeakingRate)
					? Math.max(0.5, Math.min(2.0, row.aivisSpeakingRate))
					: 1.0,
		};
	} catch {
		return null;
	}
}

async function synthesize(
	apiKey: string,
	modelUuid: string,
	text: string,
	userDictionaryUuid?: string,
	speakingRate?: number,
): Promise<Buffer> {
	const body: Record<string, unknown> = {
		model_uuid: modelUuid,
		text,
		output_format: "mp3",
	};
	if (userDictionaryUuid) body.user_dictionary_uuid = userDictionaryUuid;
	if (speakingRate !== undefined) body.speaking_rate = speakingRate;

	const res = await fetch(AIVIS_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "audio/mpeg",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Aivis API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
		);
	}

	const arrayBuffer = await res.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

function uniqueTmpPath(): string {
	return join(
		tmpdir(),
		`superset-aivis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
	);
}

function cleanup(path: string): void {
	execFile("rm", ["-f", path], () => {
		/* ignore */
	});
}

/**
 * Synthesize text via Aivis API and play it.
 * Called with explicit apiKey/modelUuid (used by both the test endpoint
 * and the runtime notification flow).
 */
export async function playAivisTts(options: {
	apiKey: string;
	modelUuid: string;
	text: string;
	volume?: number;
	speakingRate?: number;
	userDictionaryUuid?: string;
}): Promise<void> {
	const trimmed = options.text.trim();
	if (!trimmed) return;
	if (!options.apiKey || !options.modelUuid) {
		throw new Error("Aivis API key and model UUID are required");
	}

	const audio = await synthesize(
		options.apiKey,
		options.modelUuid,
		trimmed,
		options.userDictionaryUuid,
		options.speakingRate,
	);
	const path = uniqueTmpPath();
	await writeFile(path, audio);

	playSoundFile(path, options.volume ?? 100, {
		onComplete: () => cleanup(path),
	});
}

/**
 * Render the configured template for the given event and play it.
 * No-op if aivis is disabled, not configured, or the rendered text is empty.
 */
export async function playAivisNotification(
	event: AivisEventKind,
	vars: AivisPlaceholders,
): Promise<void> {
	const cfg = readAivisSettings();
	if (!cfg || !cfg.enabled) return;
	if (!cfg.apiKey || !cfg.modelUuid) return;

	const template = event === "permission" ? cfg.formatPermission : cfg.format;
	const text = renderAivisTemplate(template, vars).trim();
	if (!text) return;

	try {
		await playAivisTts({
			apiKey: cfg.apiKey,
			modelUuid: cfg.modelUuid,
			text,
			volume: cfg.volume,
			speakingRate: cfg.speakingRate,
			userDictionaryUuid: cfg.userDictionaryUuid || undefined,
		});
	} catch (err) {
		console.warn("[aivis-tts] playback failed", err);
	}
}
