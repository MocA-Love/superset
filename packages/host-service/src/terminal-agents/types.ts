import type { AgentDefinitionId } from "@superset/shared/agent-catalog";
import type { AgentIdentity } from "@superset/shared/agent-identity";

export type TerminalAgentId = AgentIdentity["agentId"];

export interface TerminalAgentBinding {
	terminalId: string;
	workspaceId: string;
	agentId: TerminalAgentId;
	agentSessionId?: string;
	definitionId?: AgentDefinitionId;
	startedAt: number;
	lastEventAt: number;
	lastEventType: string;
}
