import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const CONFIG_FILE_NAME = "chat-next-edit.json";

export const nextEditConfigSchema = z.object({
	enabled: z.boolean(),
	model: z.string().min(1).default("mercury-edit-2"),
	maxTokens: z.number().int().min(1).max(8192),
	temperature: z.number().min(0.0).max(1.0),
	topP: z.number().min(0.0).max(1.0),
	presencePenalty: z.number().min(-2.0).max(2.0),
	stop: z.array(z.string().min(1)).max(4),
});

export type NextEditConfig = z.infer<typeof nextEditConfigSchema>;

interface PersistedNextEditConfig {
	version: 1;
	config: NextEditConfig;
}

interface NextEditConfigDiskOptions {
	configPath?: string;
}

export const DEFAULT_NEXT_EDIT_CONFIG: NextEditConfig = {
	enabled: false,
	model: "mercury-edit-2",
	maxTokens: 8192,
	temperature: 0.3,
	topP: 0.8,
	presencePenalty: 1.0,
	stop: [],
};

export function getNextEditConfigPath(
	options?: NextEditConfigDiskOptions,
): string {
	if (options?.configPath) return options.configPath;
	const supersetHome =
		process.env.SUPERSET_HOME_DIR?.trim() || join(homedir(), ".superset");
	return join(supersetHome, CONFIG_FILE_NAME);
}

function readPersistedNextEditConfig(
	options?: NextEditConfigDiskOptions,
): PersistedNextEditConfig | null {
	const configPath = getNextEditConfigPath(options);
	if (!existsSync(configPath)) return null;

	try {
		const parsed = JSON.parse(
			readFileSync(configPath, "utf-8"),
		) as Partial<PersistedNextEditConfig>;
		const config = nextEditConfigSchema.safeParse(parsed.config);
		if (parsed.version !== 1 || !config.success) {
			return null;
		}

		return {
			version: 1,
			config: config.data,
		};
	} catch (error) {
		console.warn("[chat-service][next-edit] Failed to read persisted config.", {
			configPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function getNextEditConfig(
	options?: NextEditConfigDiskOptions,
): NextEditConfig {
	const persisted = readPersistedNextEditConfig(options);
	if (!persisted) {
		return { ...DEFAULT_NEXT_EDIT_CONFIG };
	}

	return {
		...DEFAULT_NEXT_EDIT_CONFIG,
		...persisted.config,
		stop: [...persisted.config.stop],
	};
}

export function setNextEditConfig(
	input: NextEditConfig,
	options?: NextEditConfigDiskOptions,
): NextEditConfig {
	const config = nextEditConfigSchema.parse(input);
	const configPath = getNextEditConfigPath(options);
	const dir = dirname(configPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const persisted: PersistedNextEditConfig = {
		version: 1,
		config,
	};
	writeFileSync(configPath, JSON.stringify(persisted, null, 2), "utf-8");
	chmodSync(configPath, 0o600);
	return config;
}
