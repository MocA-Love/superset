import { basename } from "node:path";
import { CLIError } from "@superset/cli-framework";
import type { HostServiceClient } from "./host-target";

export async function uploadAttachments(
	client: HostServiceClient,
	paths: string[],
): Promise<string[]> {
	if (paths.length === 0) return [];

	const ids: string[] = [];
	for (const path of paths) {
		const file = Bun.file(path);
		const exists = await file.exists();
		if (!exists) {
			throw new CLIError(`Attachment not found: ${path}`);
		}

		const bytes = Buffer.from(await file.arrayBuffer());
		const result = await client.attachments.upload.mutate({
			data: { kind: "base64", data: bytes.toString("base64") },
			mediaType: file.type || "application/octet-stream",
			originalFilename: basename(path),
		});
		ids.push(result.attachmentId);
	}

	return ids;
}
