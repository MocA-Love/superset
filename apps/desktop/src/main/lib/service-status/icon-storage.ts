import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net } from "electron";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";

/**
 * Filesystem backing store for user-uploaded service-status icons.
 *
 * Files live under `<superset home>/assets/service-status-icons/` and are
 * referenced by their absolute path from the `icon_value` column of
 * `service_status_definitions`. The renderer loads them via the
 * `superset-service-icon:` custom protocol.
 */

const ICONS_DIR = join(SUPERSET_HOME_DIR, "assets", "service-status-icons");

// Aligned with `selectImageFile` in `routers/window.ts` so the upload dialog
// and the on-disk whitelist never disagree. SVG is intentionally excluded —
// the renderer displays icons through `<img src>` today, but inline-SVG usage
// would expose `<script>` / `on*` handlers from user-supplied files.
const ALLOWED_ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const MAX_ICON_SIZE_BYTES = 2 * 1024 * 1024;

function ensureIconsDir(): void {
	if (!existsSync(ICONS_DIR)) {
		mkdirSync(ICONS_DIR, { recursive: true, mode: SUPERSET_HOME_DIR_MODE });
	}
	try {
		chmodSync(ICONS_DIR, SUPERSET_HOME_DIR_MODE);
	} catch {
		// Best effort only.
	}
}

function sanitizeExtension(ext: string): string {
	const lower = ext.toLowerCase();
	return ALLOWED_ICON_EXTENSIONS.has(lower) ? lower : ".png";
}

function extFromMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return ".png";
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/webp":
			return ".webp";
		default:
			return ".png";
	}
}

export interface SaveCustomIconFromDataUrlResult {
	absolutePath: string;
	filename: string;
}

/**
 * Writes a base64 data URL (as returned by `window.selectImageFile`) to disk
 * and returns the absolute path for storage in `icon_value`. Rejects files
 * larger than 2 MB — the UI renders icons at ~16-24 px so anything bigger is
 * either user error or an abuse vector.
 */
export async function saveCustomIconFromDataUrl(
	dataUrl: string,
): Promise<SaveCustomIconFromDataUrlResult> {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) {
		throw new Error("Invalid data URL");
	}
	const mimeType = match[1] ?? "image/png";
	const base64 = match[2] ?? "";
	const buffer = Buffer.from(base64, "base64");
	if (buffer.byteLength === 0) {
		throw new Error("Empty image payload");
	}
	if (buffer.byteLength > MAX_ICON_SIZE_BYTES) {
		throw new Error(
			`Icon is too large (${Math.round(buffer.byteLength / 1024)}KB). Maximum is 2MB.`,
		);
	}
	const ext = sanitizeExtension(extFromMimeType(mimeType));
	const filename = `${randomUUID()}${ext}`;
	ensureIconsDir();
	const absolutePath = join(ICONS_DIR, filename);
	await writeFile(absolutePath, buffer);
	try {
		chmodSync(absolutePath, SUPERSET_SENSITIVE_FILE_MODE);
	} catch {
		// Best effort only.
	}
	return { absolutePath, filename };
}

/**
 * Normalized boundary check — `startsWith(ICONS_DIR)` alone is unsafe because
 *   - A sibling directory like `…/service-status-icons-evil/x.png` prefix-matches.
 *   - An un-normalized `…/service-status-icons/../../etc/passwd.png` passes.
 *
 * `resolve` collapses `..` / `.` and normalizes separators; `relative` then
 * tells us whether the resolved path escapes the managed directory.
 */
function isInsideIconsDir(absolutePath: string): boolean {
	const resolvedBase = resolve(ICONS_DIR);
	let resolvedTarget: string;
	try {
		resolvedTarget = resolve(absolutePath);
	} catch {
		return false;
	}
	const rel = relative(resolvedBase, resolvedTarget);
	if (rel === "") return false;
	if (rel.startsWith("..")) return false;
	// Guards against Windows where `relative()` may return an absolute path
	// when `from` and `to` are on different drives.
	if (rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return false;
	return !rel.split(sep).includes("..");
}

/**
 * Removes a previously saved custom icon file. Safe to call with paths that
 * are outside the icons directory (they are silently ignored) — this guards
 * against a stale DB row accidentally deleting an unrelated file.
 */
export function deleteCustomIconFile(absolutePath: string | null): void {
	if (!absolutePath) return;
	if (!isInsideIconsDir(absolutePath)) return;
	if (!existsSync(absolutePath)) return;
	try {
		unlinkSync(absolutePath);
	} catch {
		// Best effort.
	}
}

/**
 * True if the given absolute path is a recognized icon under the managed dir.
 * Used by the protocol handler to gate which paths are served and by the
 * tRPC mutation layer to reject arbitrary path writes.
 */
export function isCustomIconPath(absolutePath: string): boolean {
	if (!isInsideIconsDir(absolutePath)) return false;
	return ALLOWED_ICON_EXTENSIONS.has(extname(absolutePath).toLowerCase());
}

export const SERVICE_ICON_PROTOCOL = "superset-service-icon";

/**
 * Custom-protocol handler that serves icons under the managed directory.
 * Paths outside `ICONS_DIR` are rejected so a compromised DB row can't be
 * used to read arbitrary files.
 */
export function createServiceIconProtocolHandler() {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const raw = url.pathname.replace(/^\/+/, "");
		if (!raw) return new Response("Bad request", { status: 400 });
		let decoded: string;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			return new Response("Bad request", { status: 400 });
		}
		if (!isCustomIconPath(decoded)) {
			return new Response("Forbidden", { status: 403 });
		}
		if (!existsSync(decoded)) {
			return new Response("Not found", { status: 404 });
		}
		try {
			return await net.fetch(pathToFileURL(decoded).toString());
		} catch {
			return new Response("Not found", { status: 404 });
		}
	};
}
