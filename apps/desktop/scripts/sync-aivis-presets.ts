#!/usr/bin/env bun
/**
 * One-shot: resolve the built-in Aivis preset models against the public Aivis
 * search API, download their icons into `renderer/assets/aivis-models/`, and
 * regenerate `shared/aivis-presets-data.ts`. Run when adding/removing presets
 * or when an icon URL changes upstream.
 *
 * Usage: bun run scripts/sync-aivis-presets.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PRESET_NAMES = [
	"まい",
	"花音",
	"るな",
	"桜音",
	"中2",
	"zonoko",
	"コハク",
	"まお",
	"天深シノ",
];

const BASE = "https://api.aivis-project.com";
const ASSET_DIR = join(__dirname, "../src/renderer/assets/aivis-models");
const OUT_FILE = join(
	__dirname,
	"../src/renderer/routes/_authenticated/settings/ringtones/components/AivisSettings/components/ModelPresetTiles/preset-data.ts",
);

interface AivmModel {
	aivm_model_uuid: string;
	name: string;
	user?: { name?: string; handle?: string; icon_url?: string | null };
	speakers?: Array<{
		icon_url?: string | null;
		styles?: Array<{
			voice_samples?: Array<{ audio_url?: string | null }>;
		}>;
	}>;
}

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function extFromContentType(ct: string): string {
	if (ct.includes("png")) return "png";
	if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
	if (ct.includes("webp")) return "webp";
	if (ct.includes("svg")) return "svg";
	return "png";
}

async function searchByName(name: string): Promise<AivmModel | null> {
	const url = new URL("/v1/aivm-models/search", BASE);
	url.searchParams.set("keyword", name);
	url.searchParams.set("limit", "5");
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  search failed for "${name}": ${res.status}`);
		return null;
	}
	const json = (await res.json()) as { aivm_models?: AivmModel[] };
	const models = json.aivm_models ?? [];
	const exact = models.find((m) => m.name === name);
	const summary = exact ?? models[0] ?? null;
	if (!summary) return null;
	// Search results don't include voice_samples; fetch the model detail.
	const detailRes = await fetch(
		new URL(`/v1/aivm-models/${summary.aivm_model_uuid}`, BASE),
	);
	if (!detailRes.ok) return summary;
	return (await detailRes.json()) as AivmModel;
}

function audioExtFromContentType(ct: string): string {
	if (ct.includes("mp3") || ct.includes("mpeg")) return "mp3";
	if (ct.includes("wav")) return "wav";
	if (ct.includes("ogg") || ct.includes("opus")) return "ogg";
	if (ct.includes("m4a") || ct.includes("aac") || ct.includes("mp4"))
		return "m4a";
	if (ct.includes("flac")) return "flac";
	return "mp3";
}

async function downloadAudio(
	url: string,
	name: string,
): Promise<string | null> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  sample download failed for "${name}": ${res.status}`);
		return null;
	}
	const ct = res.headers.get("content-type") ?? "audio/mpeg";
	const ext = audioExtFromContentType(ct);
	const filename = `${slug(name)}.${ext}`;
	const buf = Buffer.from(await res.arrayBuffer());
	mkdirSync(ASSET_DIR, { recursive: true });
	writeFileSync(join(ASSET_DIR, filename), buf);
	return filename;
}

async function download(url: string, name: string): Promise<string | null> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  icon download failed for "${name}": ${res.status}`);
		return null;
	}
	const ct = res.headers.get("content-type") ?? "image/png";
	const ext = extFromContentType(ct);
	const filename = `${slug(name)}.${ext}`;
	const buf = Buffer.from(await res.arrayBuffer());
	mkdirSync(ASSET_DIR, { recursive: true });
	writeFileSync(join(ASSET_DIR, filename), buf);
	return filename;
}

async function main() {
	mkdirSync(ASSET_DIR, { recursive: true });

	const entries: Array<{
		name: string;
		uuid: string;
		iconFilename: string | null;
		sampleFilename: string | null;
		authorName: string | null;
	}> = [];

	for (const name of PRESET_NAMES) {
		console.log(`Resolving "${name}"…`);
		const m = await searchByName(name);
		if (!m) {
			console.warn(`  not found, skipping`);
			continue;
		}
		const iconUrl = m.speakers?.[0]?.icon_url ?? m.user?.icon_url ?? null;
		const sampleUrl =
			m.speakers?.[0]?.styles?.[0]?.voice_samples?.[0]?.audio_url ?? null;
		const iconFilename = iconUrl ? await download(iconUrl, name) : null;
		const sampleFilename = sampleUrl
			? await downloadAudio(sampleUrl, name)
			: null;
		entries.push({
			name: m.name,
			uuid: m.aivm_model_uuid,
			iconFilename,
			sampleFilename,
			authorName: m.user?.name ?? null,
		});
		console.log(
			`  uuid=${m.aivm_model_uuid} icon=${iconFilename ?? "(none)"} sample=${sampleFilename ?? "(none)"}`,
		);
	}

	const importLines: string[] = [];
	const itemLines: string[] = [];
	for (const [i, e] of entries.entries()) {
		const iconSym = e.iconFilename ? `icon${i}` : null;
		const sampleSym = e.sampleFilename ? `sample${i}` : null;
		if (iconSym) {
			importLines.push(
				`import ${iconSym} from "renderer/assets/aivis-models/${e.iconFilename}";`,
			);
		}
		if (sampleSym) {
			importLines.push(
				`import ${sampleSym} from "renderer/assets/aivis-models/${e.sampleFilename}";`,
			);
		}
		itemLines.push(
			`\t{ uuid: ${JSON.stringify(e.uuid)}, name: ${JSON.stringify(e.name)}, iconAsset: ${iconSym ?? "null"}, sampleAsset: ${sampleSym ?? "null"}, authorName: ${JSON.stringify(e.authorName)} },`,
		);
	}

	const out = `// AUTO-GENERATED by scripts/sync-aivis-presets.ts
// Do not edit by hand. Re-run the script to refresh.
${importLines.join("\n")}

export interface AivisPresetModel {
	uuid: string;
	name: string;
	iconAsset: string | null;
	sampleAsset: string | null;
	authorName: string | null;
}

export const AIVIS_PRESET_MODELS: AivisPresetModel[] = [
${itemLines.join("\n")}
];
`;
	writeFileSync(OUT_FILE, out);
	console.log(`\nWrote ${OUT_FILE} (${entries.length} entries)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
