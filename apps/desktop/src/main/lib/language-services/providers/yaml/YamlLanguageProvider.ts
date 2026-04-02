import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class YamlLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "yaml",
			label: "YAML",
			description: "YAML diagnostics via yaml-language-server.",
			languageIds: ["yaml"],
			defaultSource: "yaml",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "yaml-language-server",
					binName: "yaml-language-server",
					args: ["--stdio"],
					cwd: workspacePath,
				}),
			configuration: {
				yaml: {
					validate: true,
					schemaStore: {
						enable: true,
						url: "https://www.schemastore.org/api/json/catalog.json",
					},
					hover: false,
					completion: false,
				},
			},
		});
	}
}
