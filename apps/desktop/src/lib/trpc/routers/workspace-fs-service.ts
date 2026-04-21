import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
	createFsHostService,
	type FsHostService,
	FsWatcherManager,
	toRelativePath,
	type WorkspaceFsPathError,
} from "@superset/workspace-fs/host";
import { TRPCError } from "@trpc/server";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { shell } from "electron";
import { getWorkspace } from "./workspaces/utils/db-helpers";
import { getWorkspacePath } from "./workspaces/utils/worktree";

const execFileAsync = promisify(execFile);

const filesystemWatcherManager = new FsWatcherManager();

// electron-builder packs node_modules into app.asar, but native binaries can't
// execute from inside asar. We unpack @vscode/ripgrep via `asarUnpack` in
// electron-builder.ts, and at runtime we rewrite the path from the asar view
// to the asar.unpacked view so `execFile` can invoke it.
const rgExecutablePath = bundledRgPath.includes(
	`${path.sep}app.asar${path.sep}`,
)
	? bundledRgPath.replace(
			`${path.sep}app.asar${path.sep}`,
			`${path.sep}app.asar.unpacked${path.sep}`,
		)
	: bundledRgPath;

async function* spawnBundledRipgrep(
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): AsyncIterable<string> {
	// Streaming counterpart to `runRipgrep`: feeds searchContentStream so the
	// Search tab can render matches as ripgrep emits them. We SIGTERM the
	// child on abort instead of relying on `spawn`'s `signal` option so we
	// can drain cleanly without propagating an AbortError into the generator.
	const child = spawn(rgExecutablePath, args, {
		cwd: options.cwd,
		windowsHide: true,
	});

	const onAbort = () => {
		if (!child.killed) child.kill("SIGTERM");
	};
	const signal = options.signal;
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	try {
		child.stdout.setEncoding("utf8");
		for await (const chunk of child.stdout as AsyncIterable<string>) {
			if (signal?.aborted) return;
			yield chunk;
		}
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				if (signal?.aborted || code === null || code === 0 || code === 1) {
					resolve();
				} else {
					const err = new Error(`ripgrep exited with code ${code}`) as Error & {
						code?: number;
					};
					err.code = code;
					reject(err);
				}
			});
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!child.killed) child.kill("SIGTERM");
	}
}

const sharedHostServiceOptions = {
	trashItem: async (absolutePath: string) => {
		await shell.trashItem(absolutePath);
	},
	runRipgrep: async (
		args: string[],
		options: { cwd: string; maxBuffer: number; signal?: AbortSignal },
	) => {
		// Shipping our own ripgrep (via @vscode/ripgrep) means users don't
		// have to `brew install ripgrep` to get .gitignore-aware search.
		// Matches VSCode's approach.
		const result = await execFileAsync(rgExecutablePath, args, {
			cwd: options.cwd,
			maxBuffer: options.maxBuffer,
			windowsHide: true,
			signal: options.signal,
		});
		return { stdout: result.stdout };
	},
	spawnRipgrep: spawnBundledRipgrep,
};

export function resolveWorkspaceRootPath(workspaceId: string): string {
	const workspace = getWorkspace(workspaceId);
	if (!workspace) {
		throw new Error(`Workspace not found: ${workspaceId}`);
	}

	const rootPath = getWorkspacePath(workspace);
	if (!rootPath) {
		throw new Error(`Workspace path not found: ${workspaceId}`);
	}

	return rootPath;
}

const serviceCache = new Map<string, FsHostService>();

export function getServiceForRootPath(rootPath: string): FsHostService {
	let service = serviceCache.get(rootPath);
	if (!service) {
		service = createFsHostService({
			rootPath,
			watcherManager: filesystemWatcherManager,
			...sharedHostServiceOptions,
		});
		serviceCache.set(rootPath, service);
	}
	return service;
}

export function getServiceForWorkspace(workspaceId: string): FsHostService {
	return getServiceForRootPath(resolveWorkspaceRootPath(workspaceId));
}

export function toRegisteredWorktreeRelativePath(
	worktreePath: string,
	absolutePath: string,
): string {
	const normalizedWorktreePath = path.resolve(worktreePath);
	const normalizedAbsolutePath = path.resolve(absolutePath);
	const relativePath = path.relative(
		normalizedWorktreePath,
		normalizedAbsolutePath,
	);

	if (
		relativePath === "" ||
		relativePath === "." ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		// This helper is only consumed by tRPC routers, so out-of-worktree access
		// should be surfaced directly as BAD_REQUEST instead of bubbling as internal.
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Path is outside worktree: ${absolutePath}`,
		});
	}

	return relativePath.replace(/\\/g, "/");
}

export { toRelativePath };
export type { WorkspaceFsPathError };
