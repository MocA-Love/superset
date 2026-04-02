import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class DockerfileLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "dockerfile",
			label: "Dockerfile",
			description:
				"Dockerfile diagnostics via dockerfile-language-server-nodejs.",
			languageIds: ["dockerfile"],
			defaultSource: "dockerfile",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "dockerfile-language-server-nodejs",
					binName: "docker-langserver",
					args: ["--stdio"],
					cwd: workspacePath,
				}),
		});
	}
}
