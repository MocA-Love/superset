import {
	getDefaultSeedPresets,
	getPresetById,
	HOST_AGENT_PRESETS,
	type HostAgentPreset,
} from "@superset/shared/host-agent-presets";

export type { PromptTransport } from "@superset/shared/agent-prompt-launch";

export type AgentPreset = HostAgentPreset;

/**
 * Compatibility alias for the host-service settings router. The source of
 * truth lives in @superset/shared so renderer fallbacks and host-service
 * seeding cannot drift.
 */
export const AGENT_PRESETS = HOST_AGENT_PRESETS;

export { getDefaultSeedPresets, getPresetById };
