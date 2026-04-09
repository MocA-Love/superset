import {
	isAbsoluteFilesystemPath,
	isRemotePath,
	normalizeComparablePath,
} from "shared/absolute-paths";
import { getImageExtensionFromMimeType } from "shared/file-types";

export const WORKSPACE_MEMOS_DIRECTORY = ".superset/memos";
export const WORKSPACE_MEMO_FILE_NAME = "memo.md";
export const DEFAULT_MEMO_DISPLAY_NAME = "Untitled Memo";
const MAX_MEMO_DISPLAY_NAME_LENGTH = 60;

function getPathSeparator(path: string): string {
	return path.includes("\\") ? "\\" : "/";
}

function joinPath(parentAbsolutePath: string, name: string): string {
	const separator = getPathSeparator(parentAbsolutePath);
	return `${parentAbsolutePath.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function padDatePart(value: number): string {
	return value.toString().padStart(2, "0");
}

function splitRelativePath(relativePath: string): string[] {
	return relativePath.split(/[\\/]+/).filter(Boolean);
}

export interface WorkspaceMemoContext {
	memoId: string;
	memoDirectoryAbsolutePath: string;
	memoFileAbsolutePath: string;
	assetsDirectoryAbsolutePath: string;
	displayName: string;
	fileName: string;
}

export function createWorkspaceMemoId(now = new Date()): string {
	const timestamp = [
		now.getFullYear(),
		padDatePart(now.getMonth() + 1),
		padDatePart(now.getDate()),
	].join("");
	const time = [
		padDatePart(now.getHours()),
		padDatePart(now.getMinutes()),
		padDatePart(now.getSeconds()),
	].join("");
	return `${timestamp}-${time}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createWorkspaceMemoContext(
	worktreePath: string,
	memoId = createWorkspaceMemoId(),
	fileName = WORKSPACE_MEMO_FILE_NAME,
): WorkspaceMemoContext {
	const memoDirectoryAbsolutePath = joinPath(
		joinPath(worktreePath, WORKSPACE_MEMOS_DIRECTORY),
		memoId,
	);

	return {
		memoId,
		memoDirectoryAbsolutePath,
		memoFileAbsolutePath: joinPath(memoDirectoryAbsolutePath, fileName),
		assetsDirectoryAbsolutePath: joinPath(memoDirectoryAbsolutePath, "assets"),
		displayName: DEFAULT_MEMO_DISPLAY_NAME,
		fileName,
	};
}

export function getWorkspaceMemoContextFromFilePath(
	filePath: string,
): WorkspaceMemoContext | null {
	if (
		!filePath ||
		isRemotePath(filePath) ||
		!isAbsoluteFilesystemPath(filePath)
	) {
		return null;
	}

	const normalizedPath = normalizeComparablePath(filePath);
	const match = normalizedPath.match(
		/^(.*\/\.superset\/memos\/([^/]+))(?:\/(.+))?$/,
	);
	if (!match) {
		return null;
	}

	const separator = getPathSeparator(filePath);
	const memoDirectoryAbsolutePath = match[1].replace(/\//g, separator);
	const relativePath = match[3] ?? WORKSPACE_MEMO_FILE_NAME;
	const fileName =
		splitRelativePath(relativePath).pop() ?? WORKSPACE_MEMO_FILE_NAME;

	return {
		memoId: match[2],
		memoDirectoryAbsolutePath,
		memoFileAbsolutePath: filePath,
		assetsDirectoryAbsolutePath: joinPath(memoDirectoryAbsolutePath, "assets"),
		displayName: DEFAULT_MEMO_DISPLAY_NAME,
		fileName,
	};
}

export function getTrustedMemoRootPath(filePath: string): string | null {
	return (
		getWorkspaceMemoContextFromFilePath(filePath)?.memoDirectoryAbsolutePath ??
		null
	);
}

export function resolveTrustedMemoImagePath(
	memoDirectoryAbsolutePath: string,
	src: string,
): string | null {
	const trimmedSrc = src.split(/[?#]/, 1)[0]?.trim() ?? "";
	if (
		trimmedSrc.length === 0 ||
		isRemotePath(trimmedSrc) ||
		isAbsoluteFilesystemPath(trimmedSrc)
	) {
		return null;
	}

	const segments = splitRelativePath(trimmedSrc);
	if (segments.length === 0) {
		return null;
	}

	const resolvedSegments: string[] = [];
	for (const segment of segments) {
		if (segment === ".") {
			continue;
		}

		if (segment === "..") {
			if (resolvedSegments.length === 0) {
				return null;
			}
			resolvedSegments.pop();
			continue;
		}

		resolvedSegments.push(segment);
	}

	if (resolvedSegments.length === 0) {
		return null;
	}

	return resolvedSegments.reduce(
		(currentAbsolutePath, segment) => joinPath(currentAbsolutePath, segment),
		memoDirectoryAbsolutePath,
	);
}

export function createMemoImageFileName(mimeType: string): string {
	const ext = getImageExtensionFromMimeType(mimeType) ?? "png";
	return `pasted-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
}

export function createMemoImageRelativePath(fileName: string): string {
	return `./assets/${fileName}`;
}

function normalizeMemoDisplayCandidate(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return "";
	}

	const withoutPrefix = trimmed
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^\[[ xX]\]\s+/, "");
	const withoutLinks = withoutPrefix
		.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	const normalized = withoutLinks
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (normalized.length <= MAX_MEMO_DISPLAY_NAME_LENGTH) {
		return normalized;
	}

	return `${normalized.slice(0, MAX_MEMO_DISPLAY_NAME_LENGTH - 3).trimEnd()}...`;
}

export function deriveMemoDisplayName(content: string): string {
	for (const line of content.split(/\r?\n/)) {
		const candidate = normalizeMemoDisplayCandidate(line);
		if (candidate.length > 0) {
			return candidate;
		}
	}

	return DEFAULT_MEMO_DISPLAY_NAME;
}
