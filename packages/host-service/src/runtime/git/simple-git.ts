import {
	buildSimpleGitUnsafeOptions,
	type SimpleGitUnsafeOptions,
} from "@superset/shared/simple-git-unsafe";
import { USER_GIT_ENV_SIMPLE_GIT_OPTIONS } from "@superset/shared/simple-git-options";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";

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

// Superset is a local Git client, so inherited user Git config/env is expected
// behavior. simple-git 3.36 blocks these hooks by default; allow them centrally
// instead of deleting individual env vars and changing Git semantics.
const SIMPLE_GIT_OPTIONS =
	USER_GIT_ENV_SIMPLE_GIT_OPTIONS satisfies Partial<SimpleGitOptions>;

export function createUserSimpleGit(baseDir?: string): SimpleGit {
	return baseDir
		? simpleGit(baseDir, SIMPLE_GIT_OPTIONS)
		: simpleGit(SIMPLE_GIT_OPTIONS);
}
