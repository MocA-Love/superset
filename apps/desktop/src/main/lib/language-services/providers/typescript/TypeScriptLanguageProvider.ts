import { resolveNodePackageBinCommand } from "../../lsp/command-resolvers";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

const SHARED_LANGUAGE_PREFERENCES = {
	includePackageJsonAutoImports: "auto",
	quoteStyle: "auto",
} as const;

const SHARED_INLAY_HINTS = {
	parameterNames: { enabled: "literals" },
	parameterTypes: { enabled: true },
	variableTypes: { enabled: false },
	propertyDeclarationTypes: { enabled: true },
	functionLikeReturnTypes: { enabled: true },
	enumMemberValues: { enabled: true },
} as const;

const SHARED_SUGGEST = {
	completeFunctionCalls: true,
} as const;

const SHARED_LANGUAGE_CONFIG = {
	preferences: SHARED_LANGUAGE_PREFERENCES,
	inlayHints: SHARED_INLAY_HINTS,
	suggest: SHARED_SUGGEST,
} as const;

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
					...SHARED_LANGUAGE_CONFIG,
					tsserver: {
						maxTsServerMemory: 8192,
						useSyntaxServer: "auto",
					},
				},
				javascript: SHARED_LANGUAGE_CONFIG,
			},
		});
	}
}
