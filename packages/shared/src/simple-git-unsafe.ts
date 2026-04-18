export interface SimpleGitUnsafeOptions {
	allowUnsafeAlias?: true;
	allowUnsafeAskPass?: true;
	allowUnsafeConfigEnvCount?: true;
	allowUnsafeConfigPaths?: true;
	allowUnsafeCredentialHelper?: true;
	allowUnsafeDiffExternal?: true;
	allowUnsafeDiffTextConv?: true;
	allowUnsafeEditor?: true;
	allowUnsafeFilter?: true;
	allowUnsafeFsMonitor?: true;
	allowUnsafeGitProxy?: true;
	allowUnsafeGpgProgram?: true;
	allowUnsafeHooksPath?: true;
	allowUnsafeMergeDriver?: true;
	allowUnsafePack?: true;
	allowUnsafePager?: true;
	allowUnsafeProtocolOverride?: true;
	allowUnsafeSshCommand?: true;
	allowUnsafeTemplateDir?: true;
}

const SIMPLE_GIT_UNSAFE_ENV_TO_OPTION = {
	EDITOR: "allowUnsafeEditor",
	GIT_ASKPASS: "allowUnsafeAskPass",
	GIT_CONFIG: "allowUnsafeConfigPaths",
	GIT_CONFIG_COUNT: "allowUnsafeConfigEnvCount",
	GIT_CONFIG_GLOBAL: "allowUnsafeConfigPaths",
	GIT_CONFIG_SYSTEM: "allowUnsafeConfigPaths",
	GIT_EDITOR: "allowUnsafeEditor",
	GIT_EXEC_PATH: "allowUnsafeConfigPaths",
	GIT_EXTERNAL_DIFF: "allowUnsafeDiffExternal",
	GIT_PAGER: "allowUnsafePager",
	GIT_PROXY_COMMAND: "allowUnsafeGitProxy",
	GIT_SEQUENCE_EDITOR: "allowUnsafeEditor",
	GIT_SSH: "allowUnsafeSshCommand",
	GIT_SSH_COMMAND: "allowUnsafeSshCommand",
	GIT_TEMPLATE_DIR: "allowUnsafeTemplateDir",
	PAGER: "allowUnsafePager",
	PREFIX: "allowUnsafeConfigPaths",
	SSH_ASKPASS: "allowUnsafeAskPass",
} as const satisfies Record<string, keyof SimpleGitUnsafeOptions>;

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createUnsafeConfigPattern(value: string): RegExp {
	return new RegExp(`^\\s*${escapeRegex(value.toLowerCase())}`);
}

function createExpandedUnsafeConfigPattern(value: string): RegExp {
	const escaped = escapeRegex(value.toLowerCase()).replace(
		/\\\./g,
		"(?:\\\\..+)?\\\\.",
	);
	return new RegExp(`^\\s*${escaped}`);
}

const SIMPLE_GIT_UNSAFE_CONFIG_PATTERNS = [
	{
		pattern: createUnsafeConfigPattern("alias"),
		option: "allowUnsafeAlias",
	},
	{
		pattern: createUnsafeConfigPattern("core.askPass"),
		option: "allowUnsafeAskPass",
	},
	{
		pattern: createUnsafeConfigPattern("core.editor"),
		option: "allowUnsafeEditor",
	},
	{
		pattern: createUnsafeConfigPattern("core.fsmonitor"),
		option: "allowUnsafeFsMonitor",
	},
	{
		pattern: createUnsafeConfigPattern("core.gitProxy"),
		option: "allowUnsafeGitProxy",
	},
	{
		pattern: createUnsafeConfigPattern("core.hooksPath"),
		option: "allowUnsafeHooksPath",
	},
	{
		pattern: createUnsafeConfigPattern("core.pager"),
		option: "allowUnsafePager",
	},
	{
		pattern: createUnsafeConfigPattern("core.sshCommand"),
		option: "allowUnsafeSshCommand",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("credential.helper"),
		option: "allowUnsafeCredentialHelper",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("diff.command"),
		option: "allowUnsafeDiffExternal",
	},
	{
		pattern: createUnsafeConfigPattern("diff.external"),
		option: "allowUnsafeDiffExternal",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("diff.textconv"),
		option: "allowUnsafeDiffTextConv",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("filter.clean"),
		option: "allowUnsafeFilter",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("filter.smudge"),
		option: "allowUnsafeFilter",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("gpg.program"),
		option: "allowUnsafeGpgProgram",
	},
	{
		pattern: createUnsafeConfigPattern("init.templateDir"),
		option: "allowUnsafeTemplateDir",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("merge.driver"),
		option: "allowUnsafeMergeDriver",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("mergetool.path"),
		option: "allowUnsafeMergeDriver",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("mergetool.cmd"),
		option: "allowUnsafeMergeDriver",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("protocol.allow"),
		option: "allowUnsafeProtocolOverride",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("remote.receivepack"),
		option: "allowUnsafePack",
	},
	{
		pattern: createExpandedUnsafeConfigPattern("remote.uploadpack"),
		option: "allowUnsafePack",
	},
	{
		pattern: createUnsafeConfigPattern("sequence.editor"),
		option: "allowUnsafeEditor",
	},
] as const satisfies ReadonlyArray<{
	pattern: RegExp;
	option: keyof SimpleGitUnsafeOptions;
}>;

function markUnsafeOption(
	options: SimpleGitUnsafeOptions,
	option: keyof SimpleGitUnsafeOptions,
): void {
	options[option] = true;
}

export function buildSimpleGitUnsafeOptions(
	env: Record<string, string>,
): SimpleGitUnsafeOptions | undefined {
	const unsafe: SimpleGitUnsafeOptions = {};
	const upperEnv = Object.fromEntries(
		Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]),
	);

	for (const key of Object.keys(upperEnv)) {
		const option =
			SIMPLE_GIT_UNSAFE_ENV_TO_OPTION[
				key as keyof typeof SIMPLE_GIT_UNSAFE_ENV_TO_OPTION
			];
		if (option) {
			markUnsafeOption(unsafe, option);
		}
	}

	const count = Number.parseInt(upperEnv.GIT_CONFIG_COUNT ?? "", 10);
	if (Number.isFinite(count) && count > 0) {
		for (let index = 0; index < count; index += 1) {
			const configKey = upperEnv[`GIT_CONFIG_KEY_${index}`];
			if (!configKey) {
				continue;
			}

			const normalizedConfigKey = configKey.trim().toLowerCase();
			for (const { pattern, option } of SIMPLE_GIT_UNSAFE_CONFIG_PATTERNS) {
				if (pattern.test(normalizedConfigKey)) {
					markUnsafeOption(unsafe, option);
				}
			}
		}
	}

	return Object.keys(unsafe).length > 0 ? unsafe : undefined;
}
