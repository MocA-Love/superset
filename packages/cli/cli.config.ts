import { boolean, defineConfig, string } from "@superset/cli-framework";

const VERSION = "0.2.20";
const DEFAULT_API_URL = "https://api.superset.sh";
const apiUrl =
	process.env.SUPERSET_API_URL || process.env.CLOUD_API_URL || DEFAULT_API_URL;

export default defineConfig({
	name: "superset",
	version: VERSION,
	commandsDir: "./src/commands",
	outfile: "./dist/superset",
	define: {
		"process.env.RELAY_URL": JSON.stringify(
			process.env.RELAY_URL ?? "https://relay.superset.sh",
		),
		"process.env.CLOUD_API_URL": JSON.stringify(apiUrl),
		"process.env.SUPERSET_API_URL": JSON.stringify(apiUrl),
		"process.env.SUPERSET_WEB_URL": JSON.stringify(
			process.env.SUPERSET_WEB_URL ?? "https://app.superset.sh",
		),
		"process.env.SUPERSET_CLI_RELEASE_REPO": JSON.stringify(
			process.env.SUPERSET_CLI_RELEASE_REPO ?? "MocA-Love/superset",
		),
		"process.env.SUPERSET_VERSION": JSON.stringify(VERSION),
	},
	globals: {
		json: boolean().desc("Output as JSON (auto-on under CI/agent envs)"),
		quiet: boolean().desc("Output IDs only"),
		device: string().env("SUPERSET_DEVICE").desc("Override device"),
		apiKey: string()
			.env("SUPERSET_API_KEY")
			.desc("Use a Superset API key (sk_live_…) instead of OAuth login"),
	},
});
