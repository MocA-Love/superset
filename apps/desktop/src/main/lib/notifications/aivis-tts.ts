import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "@superset/local-db";
import { localDb } from "../local-db";
import { playSoundFile } from "../play-sound";
import {
	AivisError,
	type AivisRateLimit,
	type AivisSynthesizeResult,
	type AivisTaskRunner,
} from "./audio-scheduler";

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
const SYNTHESIZE_TIMEOUT_MS = 30_000;

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

function parseIntHeader(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function extractRateLimit(headers: Headers): AivisRateLimit | undefined {
	const remaining = parseIntHeader(
		headers.get("X-Aivis-RateLimit-Requests-Remaining"),
	);
	const resetSeconds = parseIntHeader(
		headers.get("X-Aivis-RateLimit-Requests-Reset"),
	);
	if (remaining === undefined || resetSeconds === undefined) return undefined;
	return { remaining, resetSeconds, capturedAt: Date.now() };
}

function classifyStatus(
	status: number,
): "retryable" | "fatal" | "item-specific" {
	if (status === 401 || status === 402 || status === 404) return "fatal";
	if (status === 422) return "item-specific";
	if (status === 429) return "retryable";
	if (status >= 500 && status < 600) return "retryable";
	// Unknown 4xx — don't keep hammering, treat as item-specific.
	return "item-specific";
}

function reasonForStatus(status: number, bodyHint: string): string {
	switch (status) {
		case 401:
			return "Aivis API キーが無効です。設定画面でキーを確認してください";
		case 402:
			return "Aivis のクレジット残高が不足しています";
		case 404:
			return "Aivis の音声合成モデルが見つかりません";
		case 422:
			return `Aivis リクエスト形式が不正です: ${bodyHint.slice(0, 120)}`;
		case 429:
			return "Aivis API のレート制限に到達しました";
		case 500:
		case 502:
		case 503:
		case 504:
			return `Aivis サーバー側の一時障害 (HTTP ${status})`;
		default:
			return `Aivis API エラー (HTTP ${status}) ${bodyHint.slice(0, 120)}`;
	}
}

/**
 * Low-level synthesize call. Returns audio + rate limit snapshot, or throws
 * AivisError with classified kind.
 */
export async function synthesizeAivisAudio(options: {
	apiKey: string;
	modelUuid: string;
	text: string;
	speakingRate?: number;
	userDictionaryUuid?: string;
	signal?: AbortSignal;
}): Promise<AivisSynthesizeResult> {
	const body: Record<string, unknown> = {
		model_uuid: options.modelUuid,
		text: options.text,
		output_format: "mp3",
	};
	if (options.userDictionaryUuid)
		body.user_dictionary_uuid = options.userDictionaryUuid;
	if (options.speakingRate !== undefined)
		body.speaking_rate = options.speakingRate;

	// Compose an abort signal that times out after SYNTHESIZE_TIMEOUT_MS even
	// if the caller didn't pass one.
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(
		() => timeoutController.abort(),
		SYNTHESIZE_TIMEOUT_MS,
	);
	const signal = options.signal
		? anySignal([options.signal, timeoutController.signal])
		: timeoutController.signal;

	let res: Response;
	try {
		res = await fetch(AIVIS_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		clearTimeout(timeoutId);
		if (err instanceof Error && err.name === "AbortError") {
			throw new AivisError(
				"retryable",
				"Aivis API のリクエストがタイムアウトしました",
				undefined,
				undefined,
				err,
			);
		}
		throw new AivisError(
			"retryable",
			err instanceof Error ? err.message : String(err),
			undefined,
			undefined,
			err,
		);
	}
	clearTimeout(timeoutId);

	if (!res.ok) {
		const bodyText = await res.text().catch(() => "");
		const kind = classifyStatus(res.status);
		const reason = reasonForStatus(res.status, bodyText);
		let rateLimitReset: number | undefined;
		if (res.status === 429) {
			rateLimitReset = parseIntHeader(
				res.headers.get("X-Aivis-RateLimit-Requests-Reset"),
			);
		}
		throw new AivisError(kind, reason, res.status, rateLimitReset);
	}

	const arrayBuffer = await res.arrayBuffer();
	const audio = Buffer.from(arrayBuffer);
	return { audio, rateLimit: extractRateLimit(res.headers) };
}

function uniqueTmpPath(): string {
	return join(
		tmpdir(),
		`superset-aivis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
	);
}

function removeFile(path: string): void {
	execFile("rm", ["-f", path], () => {
		/* ignore */
	});
}

/**
 * Play pre-synthesized Aivis audio. Resolves when playback completes (or
 * is skipped because no player is available). Rejects if the player binary
 * can't be spawned at all.
 */
export async function playAivisAudio(
	audio: Buffer,
	volume: number,
): Promise<void> {
	const path = uniqueTmpPath();
	await writeFile(path, audio);

	return new Promise<void>((resolve) => {
		const proc = playSoundFile(path, volume, {
			onComplete: () => {
				removeFile(path);
				resolve();
			},
		});
		if (!proc) {
			// playSoundFile returned null (missing file / no player) — clean
			// up and resolve so the scheduler doesn't hang forever.
			removeFile(path);
			resolve();
		}
	});
}

/**
 * One-shot synthesize + play (used by the settings "test voice" button,
 * which deliberately bypasses the scheduler). Throws AivisError on failure.
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

	const { audio } = await synthesizeAivisAudio({
		apiKey: options.apiKey,
		modelUuid: options.modelUuid,
		text: trimmed,
		speakingRate: options.speakingRate,
		userDictionaryUuid: options.userDictionaryUuid || undefined,
	});
	await playAivisAudio(audio, options.volume ?? 100);
}

/**
 * Build an AivisTaskRunner for the scheduler. Returns null when Aivis is
 * disabled, not configured, or the rendered text is empty — the caller
 * should treat null as "nothing to enqueue".
 */
export function buildAivisTaskRunner(
	event: AivisEventKind,
	vars: AivisPlaceholders,
): AivisTaskRunner | null {
	const cfg = readAivisSettings();
	if (!cfg || !cfg.enabled) return null;
	if (!cfg.apiKey || !cfg.modelUuid) return null;

	const template = event === "permission" ? cfg.formatPermission : cfg.format;
	const text = renderAivisTemplate(template, vars).trim();
	if (!text) return null;

	return {
		synthesize: () =>
			synthesizeAivisAudio({
				apiKey: cfg.apiKey,
				modelUuid: cfg.modelUuid,
				text,
				speakingRate: cfg.speakingRate,
				userDictionaryUuid: cfg.userDictionaryUuid || undefined,
			}),
		play: (audio) => playAivisAudio(audio, cfg.volume),
	};
}

/**
 * Compose multiple AbortSignals into one (Node 20 has AbortSignal.any but
 * we keep a small shim for clarity / portability).
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const onAbort = (signal: AbortSignal) => () =>
		controller.abort(signal.reason);
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", onAbort(signal), { once: true });
	}
	return controller.signal;
}
