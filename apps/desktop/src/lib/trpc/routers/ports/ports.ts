import { workspaces } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import { localDb } from "main/lib/local-db";
import { loadStaticPorts } from "main/lib/static-ports";
import { portManager } from "main/lib/terminal/port-manager";
import type { DetectedPort, EnrichedPort } from "shared/types";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspacePath } from "../workspaces/utils/worktree";

export { invalidatePortLabelCache } from "./label-cache";

type PortEvent =
	| { type: "add"; port: DetectedPort }
	| { type: "remove"; port: DetectedPort };

function getLabelsForPath(worktreePath: string): Map<number, string> | null {
	const result = loadStaticPorts(worktreePath);
	if (!result.exists || result.error || !result.ports) return null;

	const labels = new Map<number, string>();
	for (const p of result.ports) {
		labels.set(p.port, p.label);
	}
	return labels;
}

/** Cache structure for workspace path + labels lookup. */
interface WorkspaceLabelInfo {
	labels: Map<number, string> | null;
	workspaceId: string;
}

function buildLabelCache(): Map<string, WorkspaceLabelInfo> {
	const cache = new Map<string, WorkspaceLabelInfo>();
	const allWs = localDb.select().from(workspaces).all();

	for (const ws of allWs) {
		const wsPath = getWorkspacePath(ws);
		if (!wsPath) continue;
		const labels = getLabelsForPath(wsPath);
		if (labels) {
			cache.set(ws.id, { labels, workspaceId: ws.id });
		}
	}

	return cache;
}

export const createPortsRouter = () => {
	return router({
		getAll: publicProcedure.query((): EnrichedPort[] => {
			const detectedPorts = portManager.getAllPorts();
			const labelCache = buildLabelCache();

			// Track which static ports have been matched with detected ports
			// key: "workspaceId:port"
			const matchedStaticPorts = new Set<string>();

			// Enrich detected ports with labels
			const enriched: EnrichedPort[] = detectedPorts.map((port) => {
				const info = labelCache.get(port.workspaceId);
				const label = info?.labels?.get(port.port) ?? null;
				if (label != null) {
					matchedStaticPorts.add(`${port.workspaceId}:${port.port}`);
				}
				return {
					port: port.port,
					workspaceId: port.workspaceId,
					label,
					detected: true,
					pid: port.pid,
					processName: port.processName,
					terminalId: port.terminalId,
					detectedAt: port.detectedAt,
					address: port.address,
					hostUrl: null,
				};
			});

			// Add static ports that were NOT detected
			for (const [wsId, info] of labelCache) {
				if (!info.labels) continue;
				for (const [portNum, label] of info.labels) {
					const key = `${wsId}:${portNum}`;
					if (matchedStaticPorts.has(key)) continue;

					enriched.push({
						port: portNum,
						workspaceId: wsId,
						label,
						detected: false,
						pid: null,
						processName: null,
						terminalId: null,
						detectedAt: null,
						address: null,
						hostUrl: null,
					});
				}
			}

			return enriched;
		}),

		subscribe: publicProcedure.subscription(() => {
			return observable<PortEvent>((emit) => {
				const onAdd = (port: DetectedPort) => {
					emit.next({ type: "add", port });
				};

				const onRemove = (port: DetectedPort) => {
					emit.next({ type: "remove", port });
				};

				portManager.on("port:add", onAdd);
				portManager.on("port:remove", onRemove);

				return () => {
					portManager.off("port:add", onAdd);
					portManager.off("port:remove", onRemove);
				};
			});
		}),

		kill: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					terminalId: z.string(),
					port: z.number().int().positive(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; error?: string }> => {
					return portManager.killPort(input);
				},
			),
	});
};
