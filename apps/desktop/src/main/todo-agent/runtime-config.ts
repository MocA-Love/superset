import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const TODO_RUNTIME_CONFIG_FILE = "runtime-config.json";

export interface TodoSessionRuntimeConfig {
	ptyEnabled: boolean;
	remoteControlEnabled: boolean;
}

function getRuntimeConfigPath(artifactPath: string): string {
	return path.join(artifactPath, TODO_RUNTIME_CONFIG_FILE);
}

function normalizeConfig(
	config: TodoSessionRuntimeConfig,
): TodoSessionRuntimeConfig {
	const ptyEnabled = config.ptyEnabled === true;
	return {
		ptyEnabled,
		remoteControlEnabled: ptyEnabled && config.remoteControlEnabled === true,
	};
}

export function readTodoSessionRuntimeConfig(params: {
	artifactPath: string;
	fallbackRemoteControlEnabled?: boolean | null;
}): TodoSessionRuntimeConfig {
	const legacyRemoteControlEnabled =
		params.fallbackRemoteControlEnabled === true;
	const legacyFallback = {
		ptyEnabled: legacyRemoteControlEnabled,
		remoteControlEnabled: legacyRemoteControlEnabled,
	};
	if (!params.artifactPath.startsWith("/")) {
		return legacyFallback;
	}

	const filePath = getRuntimeConfigPath(params.artifactPath);
	if (!existsSync(filePath)) {
		return legacyFallback;
	}

	try {
		const parsed = JSON.parse(
			readFileSync(filePath, "utf8"),
		) as Partial<TodoSessionRuntimeConfig> | null;
		if (!parsed || typeof parsed !== "object") {
			return legacyFallback;
		}
		return normalizeConfig({
			ptyEnabled: parsed.ptyEnabled === true,
			remoteControlEnabled: parsed.remoteControlEnabled === true,
		});
	} catch (error) {
		console.warn("[todo-agent] failed to read runtime config", error);
		return legacyFallback;
	}
}

export function writeTodoSessionRuntimeConfig(
	artifactPath: string,
	config: TodoSessionRuntimeConfig,
): void {
	if (!artifactPath.startsWith("/")) return;
	try {
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(
			getRuntimeConfigPath(artifactPath),
			`${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		console.warn("[todo-agent] failed to write runtime config", error);
	}
}
