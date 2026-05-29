import type { ExecutionMode } from "@superset/local-db/schema/zod";
import { buildTerminalCommand } from "renderer/lib/terminal/launch-command";
import { quote } from "shell-quote";

export type PresetOpenTarget = "new-tab" | "active-tab";
export type PresetMode = ExecutionMode;

export type PresetLaunchPlan =
	| "active-terminal"
	| "new-tab-single"
	| "new-tab-multi-pane"
	| "new-tab-per-command"
	| "active-tab-single"
	| "active-tab-multi-pane";

export function getPresetLaunchPlan({
	mode,
	target,
	commandCount,
	hasActiveTab,
	hasActiveTerminal,
}: {
	mode: PresetMode;
	target: PresetOpenTarget;
	commandCount: number;
	hasActiveTab: boolean;
	hasActiveTerminal?: boolean;
}): PresetLaunchPlan {
	const hasMultipleCommands = commandCount > 1;
	const shouldUseActiveTab =
		target === "active-tab" &&
		(mode === "split-pane" || mode === "sequential") &&
		hasActiveTab;

	if (mode === "sequential") {
		if (target === "active-tab" && hasActiveTerminal) {
			return "active-terminal";
		}
		return "new-tab-single";
	}

	if (shouldUseActiveTab) {
		return hasMultipleCommands ? "active-tab-multi-pane" : "active-tab-single";
	}

	if (mode === "new-tab" && hasMultipleCommands) {
		return "new-tab-per-command";
	}

	return hasMultipleCommands ? "new-tab-multi-pane" : "new-tab-single";
}

export function buildFocusedTerminalCommand({
	commands,
	cwd,
}: {
	commands: string[] | null | undefined;
	cwd?: string | null;
}): string | null {
	const runnableCommands = commands?.filter((command) => command.trim());
	const command = buildTerminalCommand(runnableCommands);
	if (command === null) return null;

	const trimmedCwd = cwd?.trim();
	if (!trimmedCwd) return command;

	return `cd ${quote([trimmedCwd])} && ${command}`;
}

export function shouldApplyPresetPaneName({
	currentName,
	presetName,
	userTitle,
}: {
	currentName?: string | null;
	presetName?: string | null;
	userTitle?: string | null;
}): boolean {
	const trimmedName = presetName?.trim();
	if (!trimmedName) return false;

	if (userTitle?.trim()) return false;

	const currentTitle = currentName?.trim() ?? "";
	return currentTitle === "" || currentTitle === "Terminal";
}
