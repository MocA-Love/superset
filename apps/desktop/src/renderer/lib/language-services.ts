import type { LanguageServiceProviderId } from "renderer/stores/language-service-preferences";

export function resolveLanguageServiceLanguageId(
	absolutePath: string,
): string | null {
	const normalizedPath = absolutePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;

	if (normalizedPath.endsWith(".tsx")) {
		return "typescriptreact";
	}
	if (
		normalizedPath.endsWith(".ts") ||
		normalizedPath.endsWith(".mts") ||
		normalizedPath.endsWith(".cts")
	) {
		return "typescript";
	}
	if (normalizedPath.endsWith(".jsx")) {
		return "javascriptreact";
	}
	if (
		normalizedPath.endsWith(".js") ||
		normalizedPath.endsWith(".mjs") ||
		normalizedPath.endsWith(".cjs")
	) {
		return "javascript";
	}
	if (
		normalizedPath.endsWith(".jsonc") ||
		fileName === "jsconfig.json" ||
		fileName === "settings.json" ||
		fileName === "extensions.json" ||
		fileName === "launch.json" ||
		fileName === "tasks.json" ||
		fileName === "keybindings.json" ||
		/^tsconfig\..+\.json$/.test(fileName) ||
		fileName === "tsconfig.json"
	) {
		return "jsonc";
	}
	if (normalizedPath.endsWith(".json")) {
		return "json";
	}
	if (normalizedPath.endsWith(".toml")) {
		return "toml";
	}
	if (normalizedPath.endsWith(".py") || normalizedPath.endsWith(".pyi")) {
		return "python";
	}
	if (normalizedPath.endsWith(".go")) {
		return "go";
	}
	if (normalizedPath.endsWith(".rs")) {
		return "rust";
	}
	if (normalizedPath.endsWith(".dart")) {
		return "dart";
	}
	if (normalizedPath.endsWith(".yaml") || normalizedPath.endsWith(".yml")) {
		return "yaml";
	}
	if (normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm")) {
		return "html";
	}
	if (normalizedPath.endsWith(".scss")) {
		return "scss";
	}
	if (normalizedPath.endsWith(".less")) {
		return "less";
	}
	if (normalizedPath.endsWith(".css")) {
		return "css";
	}
	if (
		fileName === "dockerfile" ||
		fileName === "containerfile" ||
		normalizedPath.endsWith(".dockerfile")
	) {
		return "dockerfile";
	}
	if (
		normalizedPath.endsWith(".graphql") ||
		normalizedPath.endsWith(".gql") ||
		normalizedPath.endsWith(".graphqls")
	) {
		return "graphql";
	}

	return null;
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
