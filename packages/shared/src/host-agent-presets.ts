import type { PromptTransport } from "./agent-prompt-launch";
import { BUILTIN_TERMINAL_AGENTS } from "./builtin-terminal-agents";

export interface HostAgentPreset {
	presetId: string;
	label: string;
	description: string;
	command: string;
	args: string[];
	promptTransport: PromptTransport;
	promptArgs: string[];
	env: Record<string, string>;
}

function tokenize(commandString: string): string[] {
	return commandString.split(/\s+/).filter(Boolean);
}

function derivePromptArgs(
	commandTokens: string[],
	promptCommand: string | undefined,
): string[] {
	if (!promptCommand) return [];

	const promptTokens = tokenize(promptCommand);
	let sharedPrefixLength = 0;
	while (
		sharedPrefixLength < commandTokens.length &&
		sharedPrefixLength < promptTokens.length &&
		commandTokens[sharedPrefixLength] === promptTokens[sharedPrefixLength]
	) {
		sharedPrefixLength += 1;
	}

	return promptTokens.slice(sharedPrefixLength);
}

/**
 * Terminal agent presets derived from `BUILTIN_TERMINAL_AGENTS`. Used as the
 * source for the seed subset when a host's agent table is empty and as the
 * install catalog the desktop picker renders.
 *
 * Launch resolution:
 *   prompt
 *     ? [command, ...args, ...promptArgs, ...(promptTransport === "argv" ? [prompt] : [])]
 *     : [command, ...args]
 *
 * Stdin transport pipes the prompt to stdin instead of pushing it to argv.
 */
export const HOST_AGENT_PRESETS: readonly HostAgentPreset[] =
	BUILTIN_TERMINAL_AGENTS.map((agent) => {
		const commandTokens = tokenize(agent.command);
		const [bin = agent.id, ...args] = commandTokens;
		return {
			presetId: agent.id,
			label: agent.label,
			description: agent.description,
			command: bin,
			args,
			promptTransport: agent.promptTransport ?? "argv",
			promptArgs: derivePromptArgs(commandTokens, agent.promptCommand),
			env: {},
		};
	});

const DEFAULT_PRESET_IDS = new Set([
	"claude",
	"amp",
	"codex",
	"gemini",
	"copilot",
]);

function clonePreset(preset: HostAgentPreset): HostAgentPreset {
	return {
		...preset,
		args: [...preset.args],
		promptArgs: [...preset.promptArgs],
		env: { ...preset.env },
	};
}

export function getDefaultSeedPresets(): HostAgentPreset[] {
	return HOST_AGENT_PRESETS.filter((preset) =>
		DEFAULT_PRESET_IDS.has(preset.presetId),
	).map(clonePreset);
}

export function getPresetById(presetId: string): HostAgentPreset | undefined {
	const preset = HOST_AGENT_PRESETS.find((item) => item.presetId === presetId);
	return preset ? clonePreset(preset) : undefined;
}
