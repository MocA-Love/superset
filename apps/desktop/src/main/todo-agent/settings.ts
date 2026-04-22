import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";
import { type TodoSettings, todoSettingsSchema } from "./types";

const SETTINGS_FILE = "todo-agent-settings.json";

/**
 * Resolve the settings directory without importing `electron`. The TODO
 * agent daemon (ELECTRON_RUN_AS_NODE=1) must be able to read the same
 * file the main process writes, and `app.getPath("userData")` is not
 * available in that context. Using the shared SUPERSET_HOME_DIR keeps
 * both processes in sync.
 *
 * Electron's `app` is imported through a try/require so a missing or
 * stubbed electron module in the daemon does not crash on module load.
 */
function getLegacyUserDataDir(): string | null {
	try {
		const required = (Function("return require") as () => NodeRequire)()(
			"electron",
		) as typeof import("electron");
		const app = required?.app;
		if (app && typeof app.getPath === "function") {
			return app.getPath("userData");
		}
		return null;
	} catch {
		return null;
	}
}

function getSettingsDir(): string {
	const base =
		process.env.SUPERSET_HOME_DIR || path.join(homedir(), SUPERSET_DIR_NAME);
	return path.join(base, "todo-agent");
}

function getSettingsPath(): string {
	const dir = getSettingsDir();
	mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, SETTINGS_FILE);
	// One-shot migration: if the new location is empty but the old
	// userData location has a settings file, copy it over so user
	// customizations aren't lost when moving to the shared directory.
	if (!existsSync(filePath)) {
		const legacyBase = getLegacyUserDataDir();
		if (legacyBase) {
			const legacyPath = path.join(legacyBase, "todo-agent", SETTINGS_FILE);
			if (existsSync(legacyPath)) {
				try {
					const raw = readFileSync(legacyPath, "utf8");
					writeFileSync(filePath, raw, "utf8");
				} catch {
					// best-effort
				}
			}
		}
	}
	return filePath;
}

const DEFAULT_SETTINGS: TodoSettings = {
	defaultMaxIterations: 10,
	defaultMaxWallClockMin: 30,
	maxConcurrentTasks: 1,
	sessionRetentionDays: 0,
	defaultAgentKind: "claude",
	defaultClaudeModel: null,
	defaultClaudeEffort: null,
	defaultCodexModel: null,
	defaultCodexEffort: null,
};

let cached: TodoSettings | null = null;

export function getTodoSettings(): TodoSettings {
	if (cached) return cached;
	const filePath = getSettingsPath();
	if (!existsSync(filePath)) {
		cached = { ...DEFAULT_SETTINGS };
		return cached;
	}
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		cached = todoSettingsSchema.parse(raw);
		return cached;
	} catch {
		cached = { ...DEFAULT_SETTINGS };
		return cached;
	}
}

export function updateTodoSettings(patch: Partial<TodoSettings>): TodoSettings {
	const current = getTodoSettings();
	const next = todoSettingsSchema.parse({ ...current, ...patch });
	cached = next;
	writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2), "utf8");
	return next;
}

/**
 * Force-refresh the in-memory cache. The daemon uses this when it
 * receives a `settingsChanged` RPC so subsequent `getTodoSettings()`
 * calls observe the latest on-disk value written by the main process.
 */
export function invalidateTodoSettingsCache(): void {
	cached = null;
}
