import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { projects, worktrees } from "@superset/local-db";
import {
	createFileProtocolResponse,
	getMediaMimeType,
	isSupportedMediaFile,
} from "./file-streaming";
import { localDb } from "./local-db";

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

		if (!isSupportedMediaFile(requestedPath)) {
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

		return createFileProtocolResponse(request, resolvedPath, {
			contentType: getMediaMimeType(resolvedPath) ?? "application/octet-stream",
			cacheControl: "no-store",
		});
	};
}
