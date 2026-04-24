import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import {
	getSleepInhibitorSnippet,
	hookScriptExtension,
	hookTemplateExtension,
	IS_WIN_AGENT,
} from "./agent-wrappers-common";
import { HOOKS_DIR } from "./paths";

export const NOTIFY_SCRIPT_NAME = IS_WIN_AGENT ? "notify.ps1" : "notify.sh";
export const NOTIFY_SCRIPT_MARKER = "# Superset agent notification hook";

const NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	`notify-hook.template.${hookTemplateExtension()}`,
);

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function getNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

// Re-exported for wrappers that need to know the active extension at runtime.
export { hookScriptExtension };

export function getNotifyScriptContent(): string {
	const template = fs.readFileSync(NOTIFY_SCRIPT_TEMPLATE_PATH, "utf-8");
	return template
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replace("{{SLEEP_INHIBITOR_SNIPPET}}", getSleepInhibitorSnippet())
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

export function createNotifyScript(): void {
	const notifyPath = getNotifyScriptPath();
	const script = getNotifyScriptContent();
	const changed = writeFileIfChanged(notifyPath, script, 0o755);
	console.log(`[agent-setup] ${changed ? "Updated" : "Verified"} notify hook`);
}
