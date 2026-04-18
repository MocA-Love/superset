import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { Readable } from "node:stream";

export const AUDIO_MIME_TYPES: Record<string, string> = {
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

export const VIDEO_MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".m4v": "video/mp4",
	".ogv": "video/ogg",
};

export const MEDIA_MIME_TYPES: Record<string, string> = {
	...AUDIO_MIME_TYPES,
	...VIDEO_MIME_TYPES,
};

type FileResponseOptions = {
	cacheControl?: string;
	contentType?: string;
};

type ByteRange = {
	start: number;
	end: number;
};

function parseRangeHeader(
	rangeHeader: string | null,
	fileSize: number,
): ByteRange | "unsatisfiable" | null {
	if (!rangeHeader) return null;

	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match) return null;

	const startStr = match[1];
	const endStr = match[2];
	let start: number;
	let end: number;

	if (startStr === "" && endStr !== "") {
		const suffix = Number.parseInt(endStr, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) {
			return "unsatisfiable";
		}
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
		start < 0 ||
		start >= fileSize
	) {
		return "unsatisfiable";
	}

	return {
		start,
		end: Math.min(end, fileSize - 1),
	};
}

function createWebStream(filePath: string, range?: ByteRange): ReadableStream {
	const nodeStream = range
		? createReadStream(filePath, range)
		: createReadStream(filePath);
	return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

function createHeaders(
	contentType: string,
	fileSize: number,
	cacheControl: string,
	range?: ByteRange,
): Record<string, string> {
	if (range) {
		return {
			"Content-Type": contentType,
			"Content-Length": String(range.end - range.start + 1),
			"Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
			"Accept-Ranges": "bytes",
			"Cache-Control": cacheControl,
		};
	}

	return {
		"Content-Type": contentType,
		"Content-Length": String(fileSize),
		"Accept-Ranges": "bytes",
		"Cache-Control": cacheControl,
	};
}

export function getMediaMimeType(filePath: string): string | null {
	const key = filePath.startsWith(".")
		? filePath.toLowerCase()
		: extname(filePath).toLowerCase();
	return MEDIA_MIME_TYPES[key] ?? null;
}

export function isSupportedMediaFile(filePath: string): boolean {
	return getMediaMimeType(filePath) !== null;
}

export async function createFileProtocolResponse(
	request: Request,
	filePath: string,
	options: FileResponseOptions = {},
): Promise<Response> {
	let fileSize: number;
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			return new Response("Not found", { status: 404 });
		}
		fileSize = fileStat.size;
	} catch {
		return new Response("Not found", { status: 404 });
	}

	const contentType = options.contentType ?? "application/octet-stream";
	const cacheControl = options.cacheControl ?? "no-store";
	const range = parseRangeHeader(request.headers.get("range"), fileSize);

	if (range === "unsatisfiable") {
		return new Response("Range not satisfiable", {
			status: 416,
			headers: { "Content-Range": `bytes */${fileSize}` },
		});
	}

	const headers = createHeaders(
		contentType,
		fileSize,
		cacheControl,
		range ?? undefined,
	);
	const status = range ? 206 : 200;
	const body =
		request.method === "HEAD"
			? null
			: createWebStream(filePath, range ?? undefined);

	return new Response(body, { status, headers });
}

export async function writeFileHttpResponse(
	req: IncomingMessage,
	res: ServerResponse<IncomingMessage>,
	filePath: string,
	options: FileResponseOptions = {},
): Promise<void> {
	let fileSize: number;
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}
		fileSize = fileStat.size;
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
		return;
	}

	const contentType = options.contentType ?? "application/octet-stream";
	const cacheControl = options.cacheControl ?? "no-store";
	const range = parseRangeHeader(req.headers.range ?? null, fileSize);

	if (range === "unsatisfiable") {
		res.writeHead(416, {
			"Content-Type": "text/plain",
			"Content-Range": `bytes */${fileSize}`,
		});
		res.end("Range not satisfiable");
		return;
	}

	const headers = createHeaders(
		contentType,
		fileSize,
		cacheControl,
		range ?? undefined,
	);
	const status = range ? 206 : 200;
	res.writeHead(status, headers);

	if (req.method === "HEAD") {
		res.end();
		return;
	}

	const stream = range
		? createReadStream(filePath, range)
		: createReadStream(filePath);
	stream.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "text/plain" });
		}
		res.end("Error reading file");
	});
	stream.pipe(res);
}
