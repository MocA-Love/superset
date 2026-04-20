import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AutomationSession,
	formatRelativeTime,
	type McpStatus,
} from "renderer/stores/browser-automation";

/**
 * Aggregates browser-automation session and binding data from the
 * main-process tRPC routers. Sessions are derived from the TODO-agent
 * session list (each row is a running Claude/Codex worker), and their
 * MCP readiness is resolved against the user's Claude/Codex config
 * files.
 *
 * `enabled` controls the expensive queries (sessions + MCP status). The
 * binding query and its subscription always run because `ConnectButton`
 * is mounted for every browser pane and needs to reflect the binding
 * state without expensive polling.
 */
export function useBrowserAutomationData({
	enabled = true,
}: {
	enabled?: boolean;
} = {}) {
	const { data: todoSessions = [], refetch: refetchSessions } =
		electronTrpc.todoAgent.listAll.useQuery(undefined, {
			enabled,
			refetchOnWindowFocus: enabled,
			refetchInterval: enabled ? 15000 : false,
		});
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
	const utils = electronTrpc.useUtils();
	electronTrpc.browserAutomation.onBindingsChanged.useSubscription(undefined, {
		onData: () => {
			utils.browserAutomation.listBindings.invalidate();
		},
	});

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
		return todoSessions
			.filter((s) => liveStatuses.has(s.status))
			.map((s) => {
				// Todo-agent rows always represent Claude Code workers (see
				// todo-daemon/claude-code-runner.ts). We label them as Claude
				// here; Codex workers would be represented by a different row
				// type if/when they land.
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
	}, [todoSessions, mcpStatus]);

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
