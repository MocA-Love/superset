import { createFileProtocolResponse, getMediaMimeType } from "./file-streaming";

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

export function createTempAudioProtocolHandler() {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const id = url.hostname;
		const filePath = registry.get(id);
		if (!filePath) {
			return new Response("Not found", { status: 404 });
		}

		return createFileProtocolResponse(request, filePath, {
			contentType: getMediaMimeType(filePath) ?? "audio/mpeg",
			cacheControl: "no-store",
		});
	};
}
