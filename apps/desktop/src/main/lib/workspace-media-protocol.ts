import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

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
		// Require absolute paths (POSIX "/" or Windows drive letter)
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

export function createWorkspaceMediaProtocolHandler() {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const filePath = decodePathFromUrl(url);
		if (!filePath) {
			return new Response("Bad request", { status: 400 });
		}

		let fileSize: number;
		try {
			const stats = await stat(filePath);
			if (!stats.isFile()) {
				return new Response("Not a file", { status: 404 });
			}
			fileSize = stats.size;
		} catch {
			return new Response("Not found", { status: 404 });
		}

		const mime = mimeForExt(extname(filePath));
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
					createReadStream(filePath, { start, end }),
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
			createReadStream(filePath),
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
