import {
	buildSimpleGitUnsafeOptions,
	type SimpleGitUnsafeOptions,
} from "@superset/shared/simple-git-unsafe";
import simpleGit, { type SimpleGit } from "simple-git";

interface CreateSimpleGitWithEnvOptions {
	baseDir?: string;
	env?: NodeJS.ProcessEnv | Record<string, string>;
}

function copyStringEnv(
	baseEnv: NodeJS.ProcessEnv | Record<string, string> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(baseEnv)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}

	return env;
}

export function createSimpleGitWithEnv(
	options: CreateSimpleGitWithEnvOptions = {},
): SimpleGit {
	const env = copyStringEnv(options.env ?? process.env);
	const unsafe = buildSimpleGitUnsafeOptions(env);
	const gitOptions: {
		baseDir?: string;
		unsafe?: SimpleGitUnsafeOptions;
	} = {};

	if (options.baseDir) {
		gitOptions.baseDir = options.baseDir;
	}
	if (unsafe) {
		gitOptions.unsafe = unsafe;
	}

	const git =
		Object.keys(gitOptions).length > 0
			? simpleGit(gitOptions as never)
			: simpleGit();
	return git.env(env);
}
