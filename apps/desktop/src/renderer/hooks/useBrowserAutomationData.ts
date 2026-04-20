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

	const { data: todoSessions = [], refetch: refetchSessions } =
		electronTrpc.todoAgent.listAll.useQuery(undefined, {
			enabled,
			refetchOnWindowFocus: enabled,
			refetchInterval: enabled ? 15000 : false,
		});
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
		electronTrpc.browserAutomation.getMcpStatus.useQuery(
			{},
			{
				enabled,
				refetchOnWindowFocus: enabled,
				refetchInterval: enabled ? 30000 : false,
			},
		);
	const { data: bindings = [] } =
		electronTrpc.browserAutomation.listBindings.useQuery(undefined, {
			// Binding changes are pushed via onBindingsChanged, so no polling.
			refetchOnWindowFocus: false,
		});
	// The binding subscription is centralized in `useBrowserBindingsSync`
	// (mounted once in ContentView), so this hook does not open one per
	// consumer.

	const sessions: AutomationSession[] = useMemo(() => {
		// Only sessions that have a live worker (or are actively scheduled to
		// wake up) should be connectable. Queued/paused/aborted/done/failed/
		// escalated sessions either never started or are terminal.
		const liveStatuses = new Set([
			"running",
			"preparing",
			"verifying",
			"waiting",
		]);
		const todo: AutomationSession[] = todoSessions
			.filter((s) => liveStatuses.has(s.status))
			.map((s) => {
				// Todo-agent rows always represent Claude Code workers (see
				// todo-daemon/claude-code-runner.ts).
				const provider = "Claude" as const;
				const mcp: McpStatus = mcpStatus
					? mcpStatus.claudeReady
						? "ready"
						: "missing"
					: "unknown";
				const displayName = s.title || `Session ${s.id.slice(0, 6)}`;
				const branchOrContext =
					s.workspaceBranch ??
					s.workspaceName ??
					(s.projectName ? s.projectName : "workspace");
				return {
					id: s.id,
					displayName,
					provider,
					kind: "Terminal",
					branchOrContextLabel: branchOrContext,
					lastActiveAt: formatRelativeTime(s.updatedAt ?? s.createdAt),
					mcpStatus: mcp,
				};
			});

		const terminal: AutomationSession[] = terminalAgents.map((t) => {
			const pane = panes[t.paneId];
			const mcp: McpStatus = mcpStatus
				? t.provider === "Codex"
					? mcpStatus.codexReady
						? "ready"
						: "missing"
					: mcpStatus.claudeReady
						? "ready"
						: "missing"
				: "unknown";
			return {
				id: `terminal:${t.paneId}`,
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

		return [...todo, ...terminal];
	}, [todoSessions, terminalAgents, mcpStatus, panes]);

	const bindingsByPane = useMemo(() => {
		const map: Record<string, string> = {};
		for (const b of bindings) map[b.paneId] = b.sessionId;
		return map;
	}, [bindings]);

	return {
		sessions,
		bindingsByPane,
		mcpStatus,
		refetchSessions,
	};
}
