import { isAgentMode, positional } from "@superset/cli-framework";
import { command } from "../../../../lib/command";

export default command({
	description: "Print an automation's prompt to stdout",
	args: [positional("id").required().desc("Automation id")],
	run: async ({ ctx, args, options }) => {
		const id = args.id as string;
		const { prompt } = await ctx.api.automation.getPrompt.query({ id });
		const globals = options as Record<string, unknown>;
		if (globals.json === true || isAgentMode()) {
			return { data: { id, prompt } };
		}

		process.stdout.write(prompt ?? "");
		return undefined;
	},
});
