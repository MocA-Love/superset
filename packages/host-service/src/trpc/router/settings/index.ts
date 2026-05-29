import { router } from "../../index";
import { agentConfigsRouter } from "./agent-configs";
import { branchPrefixRouter } from "./branch-prefix";
import { worktreeLocationRouter } from "./worktree-location";

export const settingsRouter = router({
	agentConfigs: agentConfigsRouter,
	branchPrefix: branchPrefixRouter,
	worktreeLocation: worktreeLocationRouter,
});

export type {
	HostAgentConfigDto,
	HostAgentConfigDto as HostAgentConfig,
} from "./agent-configs";
export type { AgentPreset, PromptTransport } from "./agent-presets";
export type { HostWorktreeLocationSettings } from "./worktree-location";
