import { resolveAvailableExecutable } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class RustLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "rust",
			label: "Rust",
			description: "Rust diagnostics via rust-analyzer.",
			languageIds: ["rust"],
			defaultSource: "rust-analyzer",
			resolveServerCommand: () =>
				resolveAvailableExecutable([
					{
						command:
							process.platform === "win32"
								? "rust-analyzer.exe"
								: "rust-analyzer",
						args: [],
						probeArgs: ["--version"],
						shell: false,
					},
				]),
		});
	}
}
