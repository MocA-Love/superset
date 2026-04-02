import { env } from "renderer/env.renderer";
import { toRelativeWorkspacePath } from "shared/absolute-paths";

export interface SupersetLinkProject {
	githubOwner: string | null;
	githubRepoName: string | null;
	mainRepoPath: string;
}

interface BuildSupersetOpenLinkOptions {
	project: SupersetLinkProject;
	branch?: string | null;
	worktreePath?: string | null;
	filePath?: string | null;
	line?: number | null;
	column?: number | null;
}

function normalizePathSegment(value: string): string {
	return value.replace(/\\/g, "/").trim();
}

function getRepoName(project: SupersetLinkProject): string | null {
	const githubRepoName = project.githubRepoName?.trim();
	if (githubRepoName) {
		return githubRepoName;
	}

	const segments = normalizePathSegment(project.mainRepoPath)
		.split("/")
		.filter(Boolean);
	return segments.at(-1) ?? null;
}

function normalizePositiveInteger(
	value: number | null | undefined,
): string | null {
	if (value == null) {
		return null;
	}

	const normalized = Math.trunc(value);
	return normalized > 0 ? String(normalized) : null;
}

export function buildSupersetOpenLink({
	project,
	branch,
	worktreePath,
	filePath,
	line,
	column,
}: BuildSupersetOpenLinkOptions): string | null {
	const repoName = getRepoName(project);
	if (!repoName) {
		return null;
	}

	const repo = project.githubOwner?.trim()
		? `${project.githubOwner.trim()}/${repoName}`
		: repoName;
	const url = new URL("/open", env.NEXT_PUBLIC_OPEN_LINK_URL);

	url.searchParams.set("repo", repo);

	const normalizedBranch = branch?.trim();
	if (normalizedBranch) {
		url.searchParams.set("branch", normalizedBranch);
	}

	const normalizedFilePath = filePath
		? normalizePathSegment(
				worktreePath
					? toRelativeWorkspacePath(worktreePath, filePath)
					: filePath,
			)
		: null;
	if (normalizedFilePath) {
		url.searchParams.set("file", normalizedFilePath);
	}

	const normalizedLine = normalizePositiveInteger(line);
	if (normalizedLine) {
		url.searchParams.set("line", normalizedLine);
	}

	const normalizedColumn = normalizePositiveInteger(column);
	if (normalizedColumn) {
		url.searchParams.set("column", normalizedColumn);
	}

	return url.toString();
}
