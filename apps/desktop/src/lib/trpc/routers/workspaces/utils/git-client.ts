import {
	type ExecFileOptions,
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import { access } from "node:fs/promises";
import {
	buildSimpleGitUnsafeOptions,
	type SimpleGitUnsafeOptions,
} from "@superset/shared/simple-git-unsafe";
import simpleGit, {
	type SimpleGit,
	type SimpleGitProgressEvent,
} from "simple-git";
import { getProcessEnvWithShellPath } from "./shell-env";

/**
 * Thrown when a git operation is requested against a path that no longer
 * exists on disk (typically a worktree that was deleted externally while
 * Superset's background polling kept firing). Caught by the tRPC Sentry
 * middleware and NOT reported — this is an expected race, not a bug.
 *
 * Sentry dashboard ELECTRON-26 / ELECTRON-1Z were 5000+ occurrences of
 * this case on Superset@1.4.7 before dedicated handling existed.
 */
export class WorktreePathMissingError extends Error {
	constructor(public readonly repoPath: string) {
		super(`Worktree path no longer exists: ${repoPath}`);
		this.name = "WorktreePathMissingError";
	}
}

interface CreateSimpleGitWithShellPathOptions {
	abort?: AbortSignal;
	baseEnv?: NodeJS.ProcessEnv;
	progress?: (event: SimpleGitProgressEvent) => void;
	repoPath?: string;
}

function createSimpleGitWithEnv(
	env: Record<string, string>,
	options: Omit<CreateSimpleGitWithShellPathOptions, "baseEnv"> = {},
): SimpleGit {
	const unsafe = buildSimpleGitUnsafeOptions(env);
	const gitOptions: {
		abort?: AbortSignal;
		baseDir?: string;
		progress?: (event: SimpleGitProgressEvent) => void;
		unsafe?: SimpleGitUnsafeOptions;
	} = {};

	if (options.abort) {
		gitOptions.abort = options.abort;
	}
	if (options.progress) {
		gitOptions.progress = options.progress;
	}
	if (options.repoPath) {
		gitOptions.baseDir = options.repoPath;
	}
	if (unsafe) {
		gitOptions.unsafe = unsafe;
	}

	const git =
		Object.keys(gitOptions).length > 0
			? simpleGit(gitOptions as never)
			: simpleGit();
	git.env(env);
	return git;
}

export async function createSimpleGitWithShellPath(
	options: CreateSimpleGitWithShellPathOptions = {},
): Promise<SimpleGit> {
	if (options.repoPath) {
		try {
			await access(options.repoPath);
		} catch {
			// Surface a dedicated error so callers (and the Sentry middleware)
			// can recognise the "worktree deleted externally" race and handle
			// it gracefully instead of reporting an INTERNAL_SERVER_ERROR.
			throw new WorktreePathMissingError(options.repoPath);
		}
	}
	const env = await getProcessEnvWithShellPath(options.baseEnv ?? process.env);
	return createSimpleGitWithEnv(env, options);
}

export async function getSimpleGitWithShellPath(
	repoPath?: string,
): Promise<SimpleGit> {
	return createSimpleGitWithShellPath({ repoPath });
}

export async function execGitWithShellPath(
	args: string[],
	options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">,
): Promise<{ stdout: string; stderr: string }> {
	return execGitWithShellPathWithEncoding(args, {
		...options,
		encoding: "utf8",
	});
}

export async function execGitWithShellPathBuffer(
	args: string[],
	options?: Omit<ExecFileOptions, "encoding">,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
	return execGitWithShellPathWithEncoding(args, {
		...options,
		encoding: "buffer",
	});
}

async function execGitWithShellPathWithEncoding<
	TEncoding extends BufferEncoding | "buffer",
>(
	args: string[],
	options:
		| (Omit<ExecFileOptions, "encoding"> & { encoding: TEncoding })
		| undefined,
): Promise<{
	stdout: TEncoding extends "buffer" ? Buffer : string;
	stderr: TEncoding extends "buffer" ? Buffer : string;
}> {
	const env = await getProcessEnvWithShellPath(
		options?.env ? { ...process.env, ...options.env } : process.env,
	);

	return new Promise((resolve, reject) => {
		execFile("git", args, { ...options, env }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}

			resolve({
				stdout: stdout as TEncoding extends "buffer" ? Buffer : string,
				stderr: stderr as TEncoding extends "buffer" ? Buffer : string,
			});
		});
	});
}
