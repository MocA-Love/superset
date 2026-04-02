import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class HtmlLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "html",
			label: "HTML",
			description: "HTML diagnostics via vscode-html-language-server.",
			languageIds: ["html"],
			defaultSource: "html",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "vscode-langservers-extracted",
					binName: "vscode-html-language-server",
					args: ["--stdio"],
					cwd: workspacePath,
				}),
		});
	}
}
