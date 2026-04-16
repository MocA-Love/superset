import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { type TodoSettings, todoSettingsSchema } from "./types";

const SETTINGS_FILE = "todo-agent-settings.json";

function getSettingsPath(): string {
	const dir = path.join(app.getPath("userData"), "todo-agent");
	mkdirSync(dir, { recursive: true });
	return path.join(dir, SETTINGS_FILE);
}

const DEFAULT_SETTINGS: TodoSettings = {
	defaultMaxIterations: 10,
	defaultMaxWallClockMin: 30,
	maxConcurrentTasks: 1,
	sessionRetentionDays: 0,
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
