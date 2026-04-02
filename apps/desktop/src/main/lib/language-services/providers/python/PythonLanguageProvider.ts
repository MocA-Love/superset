import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class PythonLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "python",
			label: "Python",
			description: "Python diagnostics via Pyright.",
			languageIds: ["python"],
			defaultSource: "pyright",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "pyright",
					binName: "pyright-langserver",
					args: ["--stdio"],
					cwd: workspacePath,
				}),
			configuration: {
				python: {
					analysis: {
						autoSearchPaths: true,
						useLibraryCodeForTypes: true,
						diagnosticMode: "openFilesOnly",
					},
				},
				pyright: {
					disableLanguageServices: false,
				},
			},
		});
	}
}
