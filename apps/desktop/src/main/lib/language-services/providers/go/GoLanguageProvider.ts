import { resolveAvailableExecutable } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class GoLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "go",
			label: "Go",
			description: "Go diagnostics via gopls.",
			languageIds: ["go"],
			defaultSource: "gopls",
			resolveServerCommand: () =>
				resolveAvailableExecutable([
					{
						command: process.platform === "win32" ? "gopls.exe" : "gopls",
						args: ["serve"],
						probeArgs: ["version"],
						shell: false,
					},
				]),
		});
	}
}
