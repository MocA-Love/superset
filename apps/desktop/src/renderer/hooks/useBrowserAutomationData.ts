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
 */
export function useBrowserAutomationData() {
	const { data: todoSessions = [], refetch: refetchSessions } =
		electronTrpc.todoAgent.listAll.useQuery(undefined, {
			refetchOnWindowFocus: true,
			refetchInterval: 5000,
		});
	const { data: mcpStatus } =
		electronTrpc.browserAutomation.getMcpStatus.useQuery(
			{},
			{ refetchOnWindowFocus: true, refetchInterval: 10000 },
		);
	const { data: bindings = [] } =
		electronTrpc.browserAutomation.listBindings.useQuery(undefined, {
			refetchInterval: 1000,
		});
	electronTrpc.browserAutomation.onBindingsChanged.useSubscription(undefined, {
		onData: () => {
			// The query above drives rendering; the subscription exists so the
			// query invalidates reactively when another window mutates state.
		},
	});

	const sessions: AutomationSession[] = useMemo(() => {
		return todoSessions
			.filter((s) => s.status !== "done" && s.status !== "failed")
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
