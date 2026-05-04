import { CLIError, number, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";

export default command({
	description: "Create a workspace on a device",
	options: {
		device: string().env("SUPERSET_DEVICE").desc("Device ID"),
		project: string().required().desc("Project ID"),
		name: string().required().desc("Workspace name"),
		branch: string().desc("Git branch (required unless --pr is set)"),
		pr: number().desc("PR number — derives branch via gh pr checkout"),
		baseBranch: string().desc(
			"Branch to fork from when `branch` does not exist (defaults to project default)",
		),
	},
	run: async ({ ctx }) => {
		if (!ctx.deviceId) {
			throw new CLIError(
				"No device found",
				"Use --device or run: superset devices list",
			);
		}
		throw new CLIError(
			"Not implemented",
			"Needs device command routing via websocket",
		);
	},
});
