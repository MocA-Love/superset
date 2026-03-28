import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePortsStore } from "renderer/stores";
import type { EnrichedPort } from "shared/types";

const PORTS_FALLBACK_REFETCH_INTERVAL_MS = 10_000;

export interface WorkspacePortGroup {
	workspaceId: string;
	workspaceName: string;
	ports: EnrichedPort[];
}

/**
 * Build a display-friendly name for each workspace.
 * Uses the worktree directory basename to distinguish workspaces
 * that share the same user-facing name (e.g. multiple "default" worktrees).
 */
function buildWorkspaceDisplayNames(
	groups: {
		workspaces: { id: string; name: string; worktreePath: string }[];
		sections: {
			workspaces: { id: string; name: string; worktreePath: string }[];
		}[];
	}[],
): Record<string, string> {
	const names: Record<string, string> = {};

	for (const group of groups) {
		const allWs = [
			...group.workspaces,
			...group.sections.flatMap((s) => s.workspaces),
		];
		for (const ws of allWs) {
			if (ws.worktreePath) {
				const basename = ws.worktreePath.split("/").pop() || ws.name;
				names[ws.id] =
					basename !== ws.name ? `${basename} (${ws.name})` : ws.name;
			} else {
				names[ws.id] = ws.name;
			}
		}
	}

	return names;
}

export function usePortsData() {
	// getAllGrouped is already cached by the sidebar, so this is zero-cost.
	const { data: allWorkspaceGroups } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const utils = electronTrpc.useUtils();

	const { data: detectedPorts } = electronTrpc.ports.getAll.useQuery(
		undefined,
		{
			// Keep a low-frequency safety net in case subscription events are missed.
			refetchInterval: PORTS_FALLBACK_REFETCH_INTERVAL_MS,
		},
	);

	electronTrpc.ports.subscribe.useSubscription(undefined, {
		onData: () => {
			utils.ports.getAll.invalidate();
		},
	});

	const showConfiguredOnly = usePortsStore((s) => s.showConfiguredOnly);

	const ports = useMemo(() => {
		const all = detectedPorts ?? [];
		if (!showConfiguredOnly) return all;
		return all.filter((p) => p.label != null);
	}, [detectedPorts, showConfiguredOnly]);

	const workspaceNames = useMemo(() => {
		if (!allWorkspaceGroups) return {};
		return buildWorkspaceDisplayNames(allWorkspaceGroups);
	}, [allWorkspaceGroups]);

	const workspacePortGroups = useMemo(() => {
		const groupMap = new Map<string, EnrichedPort[]>();

		for (const port of ports) {
			const existing = groupMap.get(port.workspaceId);
			if (existing) {
				existing.push(port);
			} else {
				groupMap.set(port.workspaceId, [port]);
			}
		}

		const groups: WorkspacePortGroup[] = [];
		for (const [workspaceId, wsPorts] of groupMap) {
			groups.push({
				workspaceId,
				workspaceName: workspaceNames[workspaceId] || "Unknown",
				ports: wsPorts.sort((a, b) => a.port - b.port),
			});
		}

		return groups.sort((a, b) =>
			a.workspaceName.localeCompare(b.workspaceName),
		);
	}, [ports, workspaceNames]);

	const totalPortCount = workspacePortGroups.reduce(
		(sum, g) => sum + g.ports.length,
		0,
	);

	return {
		workspacePortGroups,
		totalPortCount,
	};
}
