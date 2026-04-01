import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageServiceSeverity } from "./types";

export function toRelativeWorkspacePath(
	workspacePath: string,
	absolutePath: string,
): string | null {
	const relativePath = path.relative(workspacePath, absolutePath);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		path.isAbsolute(relativePath)
	) {
		return null;
	}

	return relativePath.split(path.sep).join("/");
}

export function absolutePathToFileUri(absolutePath: string): string {
	return pathToFileURL(absolutePath).toString();
}

export function fileUriToAbsolutePath(uri: string): string | null {
	if (!uri.startsWith("file://")) {
		return null;
	}

	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}

export function offsetToLineColumn(
	content: string,
	offset: number | null | undefined,
): { line: number | null; column: number | null } {
	if (offset === null || offset === undefined || Number.isNaN(offset)) {
		return {
			line: null,
			column: null,
		};
	}

	const boundedOffset = Math.max(0, Math.min(offset, content.length));
	let line = 1;
	let column = 1;

	for (let index = 0; index < boundedOffset; index += 1) {
		const char = content[index];
		if (char === "\n") {
			line += 1;
			column = 1;
			continue;
		}

		if (char === "\r") {
			if (content[index + 1] === "\n") {
				index += 1;
			}
			line += 1;
			column = 1;
			continue;
		}

		column += 1;
	}

	return {
		line,
		column,
	};
}

export function offsetToLspPosition(
	content: string,
	offset: number,
): {
	line: number;
	character: number;
} {
	const position = offsetToLineColumn(content, offset);
	return {
		line: Math.max((position.line ?? 1) - 1, 0),
		character: Math.max((position.column ?? 1) - 1, 0),
	};
}

export function lspSeverityToLanguageServiceSeverity(
	severity: number | null | undefined,
): LanguageServiceSeverity {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		default:
			return "hint";
	}
}
