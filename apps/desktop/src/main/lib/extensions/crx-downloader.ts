import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { app, net } from "electron";
import JSZip from "jszip";

/** Electron version string used in the CRX download URL */
const ELECTRON_VERSION = process.versions.chrome ?? "130.0.0.0";

const CRX_DOWNLOAD_URL =
	"https://clients2.google.com/service/update2/crx?response=redirect&prodversion=VERSION&acceptformat=crx2,crx3&x=id%3DID%26uc";

/**
 * Parse a Chrome Web Store URL or raw extension ID into just the extension ID.
 *
 * Accepts:
 *   - Full URL: https://chromewebstore.google.com/detail/some-name/abcdefghijklmnopabcdefghijklmnop
 *   - Short URL: https://chrome.google.com/webstore/detail/abcdefghijklmnopabcdefghijklmnop
 *   - Raw 32-char extension ID: abcdefghijklmnopabcdefghijklmnop
 */
export function parseExtensionId(input: string): string | null {
	const trimmed = input.trim();

	// Raw extension ID (32 lowercase alpha chars)
	if (/^[a-p]{32}$/.test(trimmed)) return trimmed;

	try {
		const url = new URL(trimmed);
		// New Chrome Web Store: /detail/<name>/<id> or /detail/<id>
		const segments = url.pathname.split("/").filter(Boolean);
		for (const seg of segments) {
			if (/^[a-p]{32}$/.test(seg)) return seg;
		}
	} catch {
		// Not a URL
	}

	return null;
}

/**
 * Build the CRX download URL from an extension ID.
 */
function buildCrxUrl(extensionId: string): string {
	return CRX_DOWNLOAD_URL.replace("VERSION", ELECTRON_VERSION).replace(
		"ID",
		extensionId,
	);
}

/**
 * Get the root directory where user-installed extensions are stored.
 */
export function getExtensionsDir(): string {
	return path.join(app.getPath("userData"), "extensions");
}

/**
 * Download a CRX file from Google's update servers.
 * Returns the path to the downloaded CRX file.
 */
async function downloadCrx(extensionId: string): Promise<string> {
	const tmpDir = path.join(os.tmpdir(), `superset-crx-${extensionId}`);
	if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

	const crxPath = path.join(tmpDir, `${extensionId}.crx`);
	const url = buildCrxUrl(extensionId);

	const response = await net.fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(
			`Failed to download extension ${extensionId}: HTTP ${response.status}`,
		);
	}

	const body = response.body;
	if (!body) throw new Error("Empty response body");

	const arrayBuffer = await response.arrayBuffer();
	await writeFile(crxPath, Buffer.from(arrayBuffer));

	return crxPath;
}

/**
 * Strip the CRX header and extract the ZIP payload.
 *
 * CRX3 format:
 *   [4 bytes] "Cr24" magic number
 *   [4 bytes] CRX version (3)
 *   [4 bytes] header length
 *   [header_length bytes] protobuf header
 *   [rest] ZIP data
 *
 * CRX2 format:
 *   [4 bytes] "Cr24" magic number
 *   [4 bytes] CRX version (2)
 *   [4 bytes] public key length
 *   [4 bytes] signature length
 *   [public_key_length bytes] public key
 *   [signature_length bytes] signature
 *   [rest] ZIP data
 */
function extractZipFromCrx(crxBuffer: Buffer): Buffer {
	const magic = crxBuffer.toString("ascii", 0, 4);
	if (magic !== "Cr24") {
		// Maybe it's already a ZIP
		if (crxBuffer[0] === 0x50 && crxBuffer[1] === 0x4b) {
			return crxBuffer;
		}
		throw new Error(`Invalid CRX file: unexpected magic "${magic}"`);
	}

	const version = crxBuffer.readUInt32LE(4);

	if (version === 3) {
		const headerLength = crxBuffer.readUInt32LE(8);
		const zipStart = 12 + headerLength;
		return crxBuffer.subarray(zipStart);
	}

	if (version === 2) {
		const pubKeyLength = crxBuffer.readUInt32LE(8);
		const sigLength = crxBuffer.readUInt32LE(12);
		const zipStart = 16 + pubKeyLength + sigLength;
		return crxBuffer.subarray(zipStart);
	}

	throw new Error(`Unsupported CRX version: ${version}`);
}

/**
 * Unpack a ZIP buffer into the target directory.
 */
async function unpackZip(
	zipBuffer: Buffer,
	targetDir: string,
): Promise<void> {
	const zip = await JSZip.loadAsync(zipBuffer);

	await mkdir(targetDir, { recursive: true });

	const entries = Object.entries(zip.files);
	for (const [relativePath, file] of entries) {
		const fullPath = path.join(targetDir, relativePath);

		if (file.dir) {
			await mkdir(fullPath, { recursive: true });
			continue;
		}

		// Ensure parent directory exists
		await mkdir(path.dirname(fullPath), { recursive: true });

		const content = await file.async("nodebuffer");
		await writeFile(fullPath, content);
	}
}

export interface CrxDownloadResult {
	extensionId: string;
	extensionDir: string;
	manifest: ChromeManifest;
}

export interface ChromeManifest {
	manifest_version: number;
	name: string;
	version: string;
	description?: string;
	permissions?: string[];
	optional_permissions?: string[];
	host_permissions?: string[];
	background?: {
		service_worker?: string;
		scripts?: string[];
		page?: string;
	};
	content_scripts?: Array<{
		matches: string[];
		js?: string[];
		css?: string[];
		run_at?: string;
	}>;
	action?: {
		default_popup?: string;
		default_icon?: string | Record<string, string>;
		default_title?: string;
	};
	browser_action?: {
		default_popup?: string;
		default_icon?: string | Record<string, string>;
		default_title?: string;
	};
	icons?: Record<string, string>;
	devtools_page?: string;
	chrome_url_overrides?: Record<string, string>;
	options_ui?: { page: string; open_in_tab?: boolean };
	options_page?: string;
}

/**
 * Download and install an extension from the Chrome Web Store.
 *
 * 1. Download the CRX
 * 2. Strip the CRX header to get the ZIP
 * 3. Extract into userData/extensions/<id>
 * 4. Return the extracted manifest
 */
export async function downloadAndExtractExtension(
	extensionId: string,
): Promise<CrxDownloadResult> {
	const extensionsRoot = getExtensionsDir();
	const extensionDir = path.join(extensionsRoot, extensionId);

	// Clean up any previous install
	if (existsSync(extensionDir)) {
		await rm(extensionDir, { recursive: true, force: true });
	}

	let crxPath: string | null = null;
	try {
		// Download
		crxPath = await downloadCrx(extensionId);

		// Extract ZIP from CRX
		const crxBuffer = await readFile(crxPath);
		const zipBuffer = extractZipFromCrx(crxBuffer);

		// Unpack
		await unpackZip(zipBuffer, extensionDir);

		// Read manifest
		const manifestPath = path.join(extensionDir, "manifest.json");
		if (!existsSync(manifestPath)) {
			throw new Error("Extension does not contain a manifest.json");
		}
		const manifest: ChromeManifest = JSON.parse(
			await readFile(manifestPath, "utf-8"),
		);

		return { extensionId, extensionDir, manifest };
	} catch (error) {
		// Clean up on failure
		if (existsSync(extensionDir)) {
			await rm(extensionDir, { recursive: true, force: true }).catch(
				() => {},
			);
		}
		throw error;
	} finally {
		// Clean up temp CRX
		if (crxPath) {
			const tmpDir = path.dirname(crxPath);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}
