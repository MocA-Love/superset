import { boolean, CLIError, table } from "@superset/cli-framework";
import { getHostId } from "@superset/shared/host-info";
import { command } from "../../../lib/command";

export default command({
	description: "List hosts using the legacy device view",
	options: {
		includeOffline: boolean().desc("Include offline hosts"),
	},
	display: (data) =>
		table(
			data as Record<string, unknown>[],
			["deviceName", "deviceType", "status", "deviceId"],
			["NAME", "TYPE", "STATUS", "ID"],
		),
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const localHostId = getHostId();
		const rows = await ctx.api.host.list.query({ organizationId });
		return rows
			.filter(
				(row) => options.includeOffline || row.online || row.id === localHostId,
			)
			.map((row) => ({
				deviceId: row.id,
				deviceName: row.name,
				deviceType: "desktop",
				status:
					row.id === localHostId ? "local" : row.online ? "online" : "offline",
			}));
	},
});
