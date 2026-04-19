import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { todoAgentMainDebug } from "./debug";

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
	if (!path.isAbsolute(params.artifactPath)) {
		todoAgentMainDebug.warn(
			"todo-runtime-config-read-fallback",
			{
				artifactPath: params.artifactPath,
				reason: "artifact-path-not-absolute",
				fallbackPtyEnabled: legacyFallback.ptyEnabled,
				fallbackRemoteControlEnabled: legacyFallback.remoteControlEnabled,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-runtime-config-read-fallback"],
			},
		);
		return legacyFallback;
	}

	const filePath = getRuntimeConfigPath(params.artifactPath);
	if (!existsSync(filePath)) {
		todoAgentMainDebug.warn(
			"todo-runtime-config-read-fallback",
			{
				artifactPath: params.artifactPath,
				filePath,
				reason: "runtime-config-missing",
				fallbackPtyEnabled: legacyFallback.ptyEnabled,
				fallbackRemoteControlEnabled: legacyFallback.remoteControlEnabled,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-runtime-config-read-fallback"],
			},
		);
		return legacyFallback;
	}

	try {
		const parsed = JSON.parse(
			readFileSync(filePath, "utf8"),
		) as Partial<TodoSessionRuntimeConfig> | null;
		if (!parsed || typeof parsed !== "object") {
			todoAgentMainDebug.warn(
				"todo-runtime-config-read-fallback",
				{
					artifactPath: params.artifactPath,
					filePath,
					reason: "runtime-config-invalid-json-shape",
					fallbackPtyEnabled: legacyFallback.ptyEnabled,
					fallbackRemoteControlEnabled: legacyFallback.remoteControlEnabled,
				},
				{
					captureMessage: true,
					fingerprint: ["todo.agent.main", "todo-runtime-config-read-fallback"],
				},
			);
			return legacyFallback;
		}
		const normalized = normalizeConfig({
			ptyEnabled: parsed.ptyEnabled === true,
			remoteControlEnabled: parsed.remoteControlEnabled === true,
		});
		todoAgentMainDebug.info(
			"todo-runtime-config-read",
			{
				artifactPath: params.artifactPath,
				filePath,
				ptyEnabled: normalized.ptyEnabled,
				remoteControlEnabled: normalized.remoteControlEnabled,
				usedFallback: false,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-runtime-config-read"],
			},
		);
		return normalized;
	} catch (error) {
		console.warn("[todo-agent] failed to read runtime config", error);
		todoAgentMainDebug.captureException(
			error,
			"todo-runtime-config-read-failed",
			{
				artifactPath: params.artifactPath,
				filePath,
				fallbackPtyEnabled: legacyFallback.ptyEnabled,
				fallbackRemoteControlEnabled: legacyFallback.remoteControlEnabled,
			},
			{
				fingerprint: ["todo.agent.main", "todo-runtime-config-read-failed"],
			},
		);
		return legacyFallback;
	}
}

export function writeTodoSessionRuntimeConfig(
	artifactPath: string,
	config: TodoSessionRuntimeConfig,
): void {
	if (!path.isAbsolute(artifactPath)) {
		todoAgentMainDebug.warn(
			"todo-runtime-config-write-skipped",
			{
				artifactPath,
				reason: "artifact-path-not-absolute",
				ptyEnabled: config.ptyEnabled,
				remoteControlEnabled: config.remoteControlEnabled,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-runtime-config-write-skipped"],
			},
		);
		return;
	}
	try {
		const normalized = normalizeConfig(config);
		const filePath = getRuntimeConfigPath(artifactPath);
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
		todoAgentMainDebug.info(
			"todo-runtime-config-write",
			{
				artifactPath,
				filePath,
				ptyEnabled: normalized.ptyEnabled,
				remoteControlEnabled: normalized.remoteControlEnabled,
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-runtime-config-write"],
			},
		);
	} catch (error) {
		console.warn("[todo-agent] failed to write runtime config", error);
		todoAgentMainDebug.captureException(
			error,
			"todo-runtime-config-write-failed",
			{
				artifactPath,
				ptyEnabled: config.ptyEnabled,
				remoteControlEnabled: config.remoteControlEnabled,
			},
			{
				fingerprint: ["todo.agent.main", "todo-runtime-config-write-failed"],
			},
		);
	}
}
