import { readFileSync } from "node:fs";
import { boolean, positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";

export default command({
	description: "Update an automation",
	args: [positional("id").required().desc("Automation id")],
	options: {
		name: string().desc("New name"),
		prompt: string().desc("New prompt"),
		promptFile: string().desc("Path to a file with the new prompt"),
		rrule: string().desc("New RRule body (RFC 5545)"),
		timezone: string().desc("New IANA timezone"),
		dtstart: string().desc("New ISO 8601 start anchor"),
		agent: string().desc(
			"New host agent instance id or presetId (e.g. claude, codex, superset).",
		),
		host: string().desc("New target host id"),
		device: string().desc("New target host id"),
		project: string().desc("New v2 project id"),
		workspace: string().desc("New v2 workspace id"),
		mcpScope: string().desc("Comma-separated MCP scope strings"),
		enabled: boolean().desc("Enable or pause the automation"),
	},
	run: async ({ ctx, args, options }) => {
		const id = args.id as string;
		const promptFromFile = options.promptFile
			? readFileSync(options.promptFile, "utf-8").trim()
			: undefined;
		const prompt = options.prompt ?? promptFromFile;
		if (options.host && options.device && options.host !== options.device) {
			throw new Error("Use either --host or --device, not both");
		}
		const targetHostId = options.host ?? options.device;

		if (options.enabled !== undefined) {
			await ctx.api.automation.setEnabled.mutate({
				id,
				enabled: options.enabled,
			});
		}

		const mcpScope =
			options.mcpScope !== undefined
				? options.mcpScope
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

		const result = await ctx.api.automation.update.mutate({
			id,
			name: options.name,
			rrule: options.rrule,
			timezone: options.timezone,
			dtstart: options.dtstart ? new Date(options.dtstart) : undefined,
			agent: options.agent,
			targetHostId,
			...(options.project !== undefined
				? { v2ProjectId: options.project }
				: {}),
			...(options.workspace !== undefined
				? { v2WorkspaceId: options.workspace }
				: {}),
			...(mcpScope !== undefined ? { mcpScope } : {}),
		});
		const finalResult =
			prompt !== undefined
				? await ctx.api.automation.setPrompt.mutate({ id, prompt })
				: result;

		return {
			data: finalResult,
			message: `Updated automation "${finalResult.name}"`,
		};
	},
});
