import { electronTrpcClient } from "renderer/lib/trpc-client";
import { parseBase64DataUrl } from "shared/file-types";
import {
	createMemoImageFileName,
	createMemoImageRelativePath,
	getWorkspaceMemoContextFromFilePath,
} from "./memo-paths";

function joinPath(parentAbsolutePath: string, name: string): string {
	const separator = parentAbsolutePath.includes("\\") ? "\\" : "/";
	return `${parentAbsolutePath.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Failed to read pasted image"));
				return;
			}
			resolve(reader.result);
		};
		reader.onerror = () => {
			reject(reader.error ?? new Error("Failed to read pasted image"));
		};
		reader.readAsDataURL(file);
	});
}

export async function saveMemoImageFile(input: {
	workspaceId: string;
	memoFilePath: string;
	file: File;
}): Promise<{ absolutePath: string; relativePath: string }> {
	const memo = getWorkspaceMemoContextFromFilePath(input.memoFilePath);
	if (!memo) {
		throw new Error("Image paste is only supported inside .superset memos");
	}

	const dataUrl = await readFileAsDataUrl(input.file);
	const { base64Data, mimeType } = parseBase64DataUrl(dataUrl);
	const fileName = createMemoImageFileName(mimeType);
	const absolutePath = joinPath(memo.assetsDirectoryAbsolutePath, fileName);

	await electronTrpcClient.filesystem.createDirectory.mutate({
		workspaceId: input.workspaceId,
		absolutePath: memo.assetsDirectoryAbsolutePath,
		recursive: true,
	});

	await electronTrpcClient.filesystem.writeFile.mutate({
		workspaceId: input.workspaceId,
		absolutePath,
		content: { kind: "base64", data: base64Data },
	});

	return {
		absolutePath,
		relativePath: createMemoImageRelativePath(fileName),
	};
}
