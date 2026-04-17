import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const registry = new Map<string, string>();

export function registerTempAudio(id: string, filePath: string): void {
	registry.set(id, filePath);
}

export function unregisterTempAudio(id: string): void {
	registry.delete(id);
}

export function getTempAudioPath(id: string): string | null {
	return registry.get(id) ?? null;
}

function mimeForExt(ext: string): string {
	if (ext === ".mp3") return "audio/mpeg";
	if (ext === ".wav") return "audio/wav";
	if (ext === ".ogg") return "audio/ogg";
	return "audio/mpeg";
}

export function createTempAudioProtocolHandler() {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const id = url.hostname;
		const filePath = registry.get(id);
		if (!filePath) {
			return new Response("Not found", { status: 404 });
		}
		try {
			const data = await readFile(filePath);
			const mime = mimeForExt(extname(filePath).toLowerCase());
			return new Response(data, {
				headers: {
					"Content-Type": mime,
					"Content-Length": String(data.length),
					"Accept-Ranges": "bytes",
					"Cache-Control": "no-store",
				},
			});
		} catch {
			return new Response("Error reading file", { status: 500 });
		}
	};
}
