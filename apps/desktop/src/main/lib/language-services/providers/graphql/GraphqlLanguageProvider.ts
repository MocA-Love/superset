import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class GraphqlLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "graphql",
			label: "GraphQL",
			description: "GraphQL diagnostics via graphql-language-service-cli.",
			languageIds: ["graphql"],
			defaultSource: "graphql",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "graphql-language-service-cli",
					binName: "graphql-lsp",
					args: ["server", "-m", "stream"],
					cwd: workspacePath,
				}),
			configuration: {
				"graphql-config": {
					load: {
						legacy: true,
					},
				},
			},
		});
	}
}
