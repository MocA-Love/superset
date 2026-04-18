import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { projects, worktrees } from "@superset/local-db";
import { localDb } from "./local-db";

const AUDIO_MIME: Record<string, string> = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".opus": "audio/ogg",
	".weba": "audio/webm",
};

const VIDEO_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".m4v": "video/mp4",
	".ogv": "video/ogg",
};

const ALLOWED_EXTS = new Set<string>([
	...Object.keys(AUDIO_MIME),
	...Object.keys(VIDEO_MIME),
]);

function mimeForExt(ext: string): string {
	const lower = ext.toLowerCase();
	return AUDIO_MIME[lower] ?? VIDEO_MIME[lower] ?? "application/octet-stream";
}

function decodePathFromUrl(url: URL): string | null {
	// URL format: superset-workspace-media:///<url-encoded-absolute-path>
	const raw = url.pathname.replace(/^\/+/, "");
	if (!raw) return null;
	try {
		const decoded = decodeURIComponent(raw);
		if (decoded.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(decoded)) {
			return decoded;
		}
		return null;
	} catch {
		return null;
	}
}

export function encodeWorkspaceMediaUrl(absolutePath: string): string {
	return `superset-workspace-media:///${encodeURIComponent(absolutePath)}`;
}

/**
 * Return the set of allowed workspace root paths (project main repos + worktrees),
 * each fully resolved. Paths are resolved fresh per-request so new workspaces
 * become available without an app restart.
 */
async function loadAllowedRoots(): Promise<string[]> {
	const rawRoots = [
		...localDb.select({ path: projects.mainRepoPath }).from(projects).all(),
		...localDb.select({ path: worktrees.path }).from(worktrees).all(),
	]
		.map((row) => row.path)
		.filter(
			(path): path is string => typeof path === "string" && path.length > 0,
		);

	const resolved = await Promise.all(
		rawRoots.map(async (p) => {
			try {
				return await realpath(p);
			} catch {
				return resolve(p);
			}
		}),
	);
	return Array.from(new Set(resolved));
}

function isWithinRoot(resolvedPath: string, root: string): boolean {
	if (resolvedPath === root) return true;
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	return resolvedPath.startsWith(rootWithSep);
}

export function createWorkspaceMediaProtocolHandler() {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const requestedPath = decodePathFromUrl(url);
		if (!requestedPath) {
			return new Response("Bad request", { status: 400 });
		}

		const ext = extname(requestedPath).toLowerCase();
		if (!ALLOWED_EXTS.has(ext)) {
			return new Response("Forbidden", { status: 403 });
		}

		let resolvedPath: string;
		try {
			resolvedPath = await realpath(requestedPath);
		} catch {
			return new Response("Not found", { status: 404 });
		}

		const roots = await loadAllowedRoots();
		const withinWorkspace = roots.some((root) =>
			isWithinRoot(resolvedPath, root),
		);
		if (!withinWorkspace) {
			return new Response("Forbidden", { status: 403 });
		}

		let fileSize: number;
		try {
			const stats = await stat(resolvedPath);
			if (!stats.isFile()) {
				return new Response("Not a file", { status: 404 });
			}
			fileSize = stats.size;
		} catch {
			return new Response("Not found", { status: 404 });
		}

		const mime = mimeForExt(ext);
		const rangeHeader = request.headers.get("range");

		if (rangeHeader) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
			if (match) {
				const startStr = match[1];
				const endStr = match[2];
				let start: number;
				let end: number;
				if (startStr === "" && endStr !== "") {
					const suffix = Number.parseInt(endStr, 10);
					start = Math.max(0, fileSize - suffix);
					end = fileSize - 1;
				} else {
					start = Number.parseInt(startStr, 10);
					end = endStr ? Number.parseInt(endStr, 10) : fileSize - 1;
				}
				if (
					!Number.isFinite(start) ||
					!Number.isFinite(end) ||
					start > end ||
					start >= fileSize
				) {
					return new Response("Range not satisfiable", {
						status: 416,
						headers: { "Content-Range": `bytes */${fileSize}` },
					});
				}
				end = Math.min(end, fileSize - 1);
				const stream = Readable.toWeb(
					createReadStream(resolvedPath, { start, end }),
				) as unknown as ReadableStream;
				return new Response(stream, {
					status: 206,
					headers: {
						"Content-Type": mime,
						"Content-Length": String(end - start + 1),
						"Content-Range": `bytes ${start}-${end}/${fileSize}`,
						"Accept-Ranges": "bytes",
						"Cache-Control": "no-store",
					},
				});
			}
		}

		const stream = Readable.toWeb(
			createReadStream(resolvedPath),
		) as unknown as ReadableStream;
		return new Response(stream, {
			headers: {
				"Content-Type": mime,
				"Content-Length": String(fileSize),
				"Accept-Ranges": "bytes",
				"Cache-Control": "no-store",
			},
		});
	};
}
