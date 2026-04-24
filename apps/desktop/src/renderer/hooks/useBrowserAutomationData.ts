import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AutomationSession,
	formatRelativeTime,
	type McpStatus,
} from "renderer/stores/browser-automation";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * Aggregates browser-automation session and binding data from the
 * main-process tRPC routers. Sessions come from two sources:
 *
 *   1. TODO-Agent sessions (Claude Code workers the supervisor is running).
 *   2. Terminal panes that currently have a `claude` or `codex` child
 *      process. The binding key for this kind is the terminal's paneId so
 *      that it self-heals across shell re-spawns inside the same pane.
 *
 * MCP readiness is resolved against the user's Claude/Codex config files.
 *
 * `enabled` controls the expensive queries. The binding query and its
 * subscription always run because `ConnectButton` is mounted for every
 * browser pane and needs to reflect the binding state without polling.
 */
export function useBrowserAutomationData({
	enabled = true,
}: {
	enabled?: boolean;
} = {}) {
	const panes = useTabsStore((s) => s.panes);

	const { data: terminalAgents = [] } =
		electronTrpc.browserAutomation.listTerminalAgentSessions.useQuery(
			undefined,
			{
				enabled,
				refetchOnWindowFocus: enabled,
				refetchInterval: enabled ? 10000 : false,
			},
		);
	const { data: mcpStatus } =
		electronTrpc.browserAutomation.getMcpStatus.useQuery(undefined, {
			enabled,
			refetchOnWindowFocus: enabled,
			refetchInterval: enabled ? 30000 : false,
		});
	const { data: bindings = [] } =
		electronTrpc.browserAutomation.listBindings.useQuery(undefined, {
			// Binding changes are pushed via onBindingsChanged, so no polling.
			refetchOnWindowFocus: false,
		});
	// The binding subscription is centralized in `useBrowserBindingsSync`
	// (mounted once in ContentView), so this hook does not open one per
	// consumer.

	const sessions: AutomationSession[] = useMemo(() => {
		// TODO-Agent sessions are intentionally hidden here. The browser-mcp
		// bridge resolves MCP → session by walking terminal PTY trees, and
		// the TODO-Agent daemon runs in a separate process so its worker
		// PIDs are not visible to the bridge. Showing TODO-Agent rows would
		// let users build bindings that always fail at tool-call time.
		// Re-enable once the daemon-bridge IPC pipe lands.
		const claudeReadyForWorkspace = (workspaceId: string | null): McpStatus => {
			if (!mcpStatus) return "unknown";
			if (mcpStatus.claudeHomeReady) return "ready";
			if (workspaceId && mcpStatus.claudeReadyByWorkspaceId[workspaceId])
				return "ready";
			return "missing";
		};
		return terminalAgents.map((t): AutomationSession => {
			const pane = panes[t.paneId];
			const mcp: McpStatus =
				t.provider === "Codex"
					? mcpStatus
						? mcpStatus.codexReady
							? "ready"
							: "missing"
						: "unknown"
					: claudeReadyForWorkspace(t.workspaceId);
			return {
				id: `terminal:${t.paneId}`,
				paneId: t.paneId,
				workspaceId: t.workspaceId ?? null,
				displayName: pane?.userTitle || pane?.name || `Terminal ${t.command}`,
				provider: t.provider,
				kind: "Terminal",
				branchOrContextLabel: t.command,
				lastActiveAt: t.lastAttachedAt
					? formatRelativeTime(Date.parse(t.lastAttachedAt))
					: "active",
				mcpStatus: mcp,
			};
		});
	}, [terminalAgents, mcpStatus, panes]);

	const bindingsByPane = useMemo(() => {
		const map: Record<string, string> = {};
		for (const b of bindings) map[b.paneId] = b.sessionId;
		return map;
	}, [bindings]);

	return {
		sessions,
		bindingsByPane,
		mcpStatus,
	};
}
