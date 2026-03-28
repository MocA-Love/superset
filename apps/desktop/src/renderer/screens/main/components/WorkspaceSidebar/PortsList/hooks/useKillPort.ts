import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { EnrichedPort } from "shared/types";

export function useKillPort() {
	const killMutation = electronTrpc.ports.kill.useMutation();

	const killPort = async (port: EnrichedPort) => {
		if (!port.paneId) return;
		const result = await killMutation.mutateAsync({
			paneId: port.paneId,
			port: port.port,
		});
		if (!result.success) {
			toast.error(`Failed to close port ${port.port}`, {
				description: result.error,
			});
		}
	};

	const killPorts = async (ports: EnrichedPort[]) => {
		const killable = ports.filter((p) => p.paneId != null);
		if (killable.length === 0) return;

		const results = await Promise.all(
			killable.map((port) =>
				killMutation.mutateAsync({
					paneId: port.paneId as string,
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
