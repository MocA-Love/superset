import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export type ResolvedLspCommand = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: boolean;
};

type NodePackageCommandOptions = {
	packageName: string;
	binName?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
};

type ExecutableCandidate = {
	command: string;
	args?: string[];
	probeArgs?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: boolean;
};

export async function resolveNodePackageBinCommand(
	options: NodePackageCommandOptions,
): Promise<ResolvedLspCommand> {
	const packageJsonPath = require.resolve(
		`${options.packageName}/package.json`,
	);
	const packageRoot = path.dirname(packageJsonPath);
	const packageJson = JSON.parse(
		await fs.readFile(packageJsonPath, "utf8"),
	) as {
		bin?: string | Record<string, string>;
	};

	const binEntry =
		typeof packageJson.bin === "string"
			? packageJson.bin
			: options.binName
				? packageJson.bin?.[options.binName]
				: Object.values(packageJson.bin ?? {})[0];

	if (!binEntry) {
		throw new Error(
			`Package ${options.packageName} does not expose a runnable binary`,
		);
	}

	return {
		command: process.execPath,
		args: [path.join(packageRoot, binEntry), ...(options.args ?? [])],
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
			ELECTRON_RUN_AS_NODE: "1",
		},
		shell: false,
	};
}

export function resolveAvailableExecutable(
	candidates: ExecutableCandidate[],
): ResolvedLspCommand | null {
	for (const candidate of candidates) {
		const probeResult = spawnSync(
			candidate.command,
			candidate.probeArgs ?? ["--version"],
			{
				cwd: candidate.cwd,
				env: {
					...process.env,
					...candidate.env,
				},
				shell: candidate.shell,
				stdio: "ignore",
			},
		);
		if (probeResult.status !== 0) {
			continue;
		}

		return {
			command: candidate.command,
			args: candidate.args,
			cwd: candidate.cwd,
			env: candidate.env,
			shell: candidate.shell,
		};
	}

	return null;
}
