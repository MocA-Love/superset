import {
	type ExecFileOptions,
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import {
	buildSimpleGitUnsafeOptions,
	type SimpleGitUnsafeOptions,
} from "@superset/shared/simple-git-unsafe";
import simpleGit, {
	type SimpleGit,
	type SimpleGitProgressEvent,
} from "simple-git";
import { getProcessEnvWithShellPath } from "./shell-env";

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
