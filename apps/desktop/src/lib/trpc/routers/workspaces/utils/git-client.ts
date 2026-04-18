import {
	type ExecFileOptions,
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import simpleGit, { type SimpleGit } from "simple-git";
import {
	getProcessEnvWithShellPath,
	stripSimpleGitUnsafeEnv,
} from "./shell-env";

export async function getSimpleGitWithShellPath(
	repoPath?: string,
): Promise<SimpleGit> {
	const git = repoPath ? simpleGit(repoPath) : simpleGit();
	git.env(stripSimpleGitUnsafeEnv(await getProcessEnvWithShellPath()));
	return git;
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
	const env = stripSimpleGitUnsafeEnv(
		await getProcessEnvWithShellPath(
			options?.env ? { ...process.env, ...options.env } : process.env,
		),
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
