import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

export class TypeScriptLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "typescript",
			label: "TypeScript",
			description:
				"TypeScript, JavaScript, TSX, JSX language services via vtsls (VSCode-equivalent tsserver wrapper).",
			languageIds: [
				"typescript",
				"typescriptreact",
				"javascript",
				"javascriptreact",
			],
			defaultSource: "ts",
			resolveServerCommand: async ({ workspacePath }) =>
				await resolveNodePackageBinCommand({
					packageName: "@vtsls/language-server",
					binName: "vtsls",
					args: ["--stdio"],
					cwd: workspacePath,
				}),
			configuration: {
				typescript: {
					tsserver: {
						maxTsServerMemory: 8192,
						useSyntaxServer: "auto",
					},
					preferences: {
						includePackageJsonAutoImports: "auto",
						quoteStyle: "auto",
					},
					inlayHints: {
						parameterNames: { enabled: "literals" },
						parameterTypes: { enabled: true },
						variableTypes: { enabled: false },
						propertyDeclarationTypes: { enabled: true },
						functionLikeReturnTypes: { enabled: true },
						enumMemberValues: { enabled: true },
					},
					suggest: {
						completeFunctionCalls: true,
					},
				},
				javascript: {
					preferences: {
						includePackageJsonAutoImports: "auto",
						quoteStyle: "auto",
					},
					inlayHints: {
						parameterNames: { enabled: "literals" },
						parameterTypes: { enabled: true },
						variableTypes: { enabled: false },
						propertyDeclarationTypes: { enabled: true },
						functionLikeReturnTypes: { enabled: true },
						enumMemberValues: { enabled: true },
					},
					suggest: {
						completeFunctionCalls: true,
					},
				},
			},
		});
	}
}
