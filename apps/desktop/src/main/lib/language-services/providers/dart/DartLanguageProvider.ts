import { resolveAvailableExecutable } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class DartLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "dart",
			label: "Dart",
			description:
				"Dart and Flutter language services via the Dart analysis server (LSP mode).",
			languageIds: ["dart"],
			defaultSource: "dart",
			resolveServerCommand: () =>
				resolveAvailableExecutable([
					{
						command: process.platform === "win32" ? "dart.exe" : "dart",
						args: [
							"language-server",
							"--client-id=superset-desktop",
							"--client-version=1.0",
							"--protocol=lsp",
						],
						probeArgs: ["--version"],
						shell: false,
					},
				]),
			initializationOptions: {
				closingLabels: true,
				outline: true,
				flutterOutline: true,
				suggestFromUnimportedLibraries: true,
			},
		});
	}
}
