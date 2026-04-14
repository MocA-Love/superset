import type { LanguageServiceProviderId } from "renderer/stores/language-service-preferences";
import { resolveFileLanguageServiceLanguageId } from "shared/language-registry";

export function resolveLanguageServiceLanguageId(
	absolutePath: string,
): string | null {
	return resolveFileLanguageServiceLanguageId(absolutePath);
}

export function resolveLanguageServiceProviderId(
	languageId: string,
): LanguageServiceProviderId | null {
	switch (languageId) {
		case "typescript":
		case "typescriptreact":
		case "javascript":
		case "javascriptreact":
			return "typescript";
		case "json":
		case "jsonc":
			return "json";
		case "yaml":
			return "yaml";
		case "html":
			return "html";
		case "css":
		case "scss":
		case "less":
			return "css";
		case "toml":
			return "toml";
		case "dart":
			return "dart";
		case "python":
			return "python";
		case "go":
			return "go";
		case "rust":
			return "rust";
		case "dockerfile":
			return "dockerfile";
		case "graphql":
			return "graphql";
		default:
			return null;
	}
}
