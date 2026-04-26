import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { EnrichedPort } from "shared/types";

// FORK NOTE: v1 PortsList uses terminalId-based kill routing on EnrichedPort.
// upstream PR #3676 introduced `usePortKillActions` for v2 with terminalId +
// hostUrl routing, but the v1 schema (terminalId, no hostUrl on local Electron
// ports) is incompatible — keep the inline implementation until v1 is retired.
export function useKillPort() {
	const killMutation = electronTrpc.ports.kill.useMutation();

	const killPort = async (port: EnrichedPort) => {
		if (!port.terminalId) return;
		const result = await killMutation.mutateAsync({
			workspaceId: port.workspaceId,
			terminalId: port.terminalId,
			port: port.port,
		});
		if (!result.success) {
			toast.error(`Failed to close port ${port.port}`, {
				description: result.error,
			});
		}
	};

	const killPorts = async (ports: EnrichedPort[]) => {
		const killable = ports.filter((p) => p.terminalId != null);
		if (killable.length === 0) return;

		const results = await Promise.all(
			killable.map((port) =>
				killMutation.mutateAsync({
					workspaceId: port.workspaceId,
					terminalId: port.terminalId as string,
					port: port.port,
				}),
			),
		);

		const failed = results.filter((r) => !r.success);
		if (failed.length > 0) {
			toast.error(`Failed to close ${failed.length} port(s)`);
		}
	};

	return { killPort, killPorts, isPending: killMutation.isPending };
}
