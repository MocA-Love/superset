import {
	LanguageDescription,
	StreamLanguage,
	type StreamParser,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
	csvStreamLanguage,
	graphqlStreamLanguage,
	makefileStreamLanguage,
	tsvStreamLanguage,
} from "./streamLanguages";

/**
 * Language descriptions for nested code blocks inside Markdown.
 * Each entry lazily loads its parser only when a matching fenced code block is found.
 */
const markdownCodeLanguages: LanguageDescription[] = [
	LanguageDescription.of({
		name: "javascript",
		alias: ["js", "jsx", "mjs", "cjs"],
		async load() {
			const { javascript } = await import("@codemirror/lang-javascript");
			return new (await import("@codemirror/language")).LanguageSupport(
				javascript({ jsx: true }).language,
			);
		},
	}),
	LanguageDescription.of({
		name: "typescript",
		alias: ["ts", "tsx"],
		async load() {
			const { javascript } = await import("@codemirror/lang-javascript");
			return new (await import("@codemirror/language")).LanguageSupport(
				javascript({ typescript: true, jsx: true }).language,
			);
		},
	}),
	LanguageDescription.of({
		name: "json",
		alias: ["jsonc"],
		async load() {
			const { json } = await import("@codemirror/lang-json");
			return new (await import("@codemirror/language")).LanguageSupport(
				json().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "html",
		alias: ["htm"],
		async load() {
			const { html } = await import("@codemirror/lang-html");
			return new (await import("@codemirror/language")).LanguageSupport(
				html().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "css",
		alias: ["scss", "less"],
		async load() {
			const { css } = await import("@codemirror/lang-css");
			return new (await import("@codemirror/language")).LanguageSupport(
				css().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "python",
		alias: ["py"],
		async load() {
			const { python } = await import("@codemirror/lang-python");
			return new (await import("@codemirror/language")).LanguageSupport(
				python().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "yaml",
		alias: ["yml"],
		async load() {
			const { yaml } = await import("@codemirror/lang-yaml");
			return new (await import("@codemirror/language")).LanguageSupport(
				yaml().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "xml",
		async load() {
			const { xml } = await import("@codemirror/lang-xml");
			return new (await import("@codemirror/language")).LanguageSupport(
				xml().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "sql",
		async load() {
			const { sql } = await import("@codemirror/lang-sql");
			return new (await import("@codemirror/language")).LanguageSupport(
				sql().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "rust",
		alias: ["rs"],
		async load() {
			const { rust } = await import("@codemirror/lang-rust");
			return new (await import("@codemirror/language")).LanguageSupport(
				rust().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "java",
		async load() {
			const { java } = await import("@codemirror/lang-java");
			return new (await import("@codemirror/language")).LanguageSupport(
				java().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "cpp",
		alias: ["c", "h", "hpp"],
		async load() {
			const { cpp } = await import("@codemirror/lang-cpp");
			return new (await import("@codemirror/language")).LanguageSupport(
				cpp().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "go",
		alias: ["golang"],
		async load() {
			const { go } = await import("@codemirror/lang-go");
			return new (await import("@codemirror/language")).LanguageSupport(
				go().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "php",
		async load() {
			const { php } = await import("@codemirror/lang-php");
			return new (await import("@codemirror/language")).LanguageSupport(
				php().language,
			);
		},
	}),
	LanguageDescription.of({
		name: "shell",
		alias: ["bash", "sh", "zsh"],
		async load() {
			const mod = await import("@codemirror/legacy-modes/mode/shell");
			const lang = StreamLanguage.define(mod.shell as StreamParser<unknown>);
			return new (await import("@codemirror/language")).LanguageSupport(lang);
		},
	}),
	LanguageDescription.of({
		name: "dockerfile",
		alias: ["docker"],
		async load() {
			const mod = await import("@codemirror/legacy-modes/mode/dockerfile");
			const lang = StreamLanguage.define(
				mod.dockerFile as StreamParser<unknown>,
			);
			return new (await import("@codemirror/language")).LanguageSupport(lang);
		},
	}),
	LanguageDescription.of({
		name: "toml",
		async load() {
			const mod = await import("@codemirror/legacy-modes/mode/toml");
			const lang = StreamLanguage.define(mod.toml as StreamParser<unknown>);
			return new (await import("@codemirror/language")).LanguageSupport(lang);
		},
	}),
	LanguageDescription.of({
		name: "ruby",
		alias: ["rb"],
		async load() {
			const mod = await import("@codemirror/legacy-modes/mode/ruby");
			const lang = StreamLanguage.define(mod.ruby as StreamParser<unknown>);
			return new (await import("@codemirror/language")).LanguageSupport(lang);
		},
	}),
	LanguageDescription.of({
		name: "swift",
		async load() {
			const mod = await import("@codemirror/legacy-modes/mode/swift");
			const lang = StreamLanguage.define(mod.swift as StreamParser<unknown>);
			return new (await import("@codemirror/language")).LanguageSupport(lang);
		},
	}),
];

async function loadLegacyLanguage(
	loader: () => Promise<Record<string, unknown>>,
	key: string,
): Promise<Extension> {
	const languageModule = await loader();
	return StreamLanguage.define(languageModule[key] as StreamParser<unknown>);
}

export async function loadLanguageSupport(
	language: string,
): Promise<Extension | null> {
	switch (language) {
		case "typescript":
		case "javascript": {
			const { javascript } = await import("@codemirror/lang-javascript");
			return javascript({
				typescript: language === "typescript",
				jsx: true,
			});
		}
		case "json": {
			const { json } = await import("@codemirror/lang-json");
			return json();
		}
		case "jsonc": {
			const { json } = await import("@codemirror/lang-json");
			return json();
		}
		case "html": {
			const { html } = await import("@codemirror/lang-html");
			return html();
		}
		case "css":
		case "scss":
		case "less": {
			const { css } = await import("@codemirror/lang-css");
			return css();
		}
		case "markdown": {
			const { markdown } = await import("@codemirror/lang-markdown");
			return markdown({ codeLanguages: markdownCodeLanguages });
		}
		case "graphql":
			return StreamLanguage.define(graphqlStreamLanguage);
		case "plaintext":
			return null;
		case "yaml": {
			const { yaml } = await import("@codemirror/lang-yaml");
			return yaml();
		}
		case "xml": {
			const { xml } = await import("@codemirror/lang-xml");
			return xml();
		}
		case "python": {
			const { python } = await import("@codemirror/lang-python");
			return python();
		}
		case "rust": {
			const { rust } = await import("@codemirror/lang-rust");
			return rust();
		}
		case "sql": {
			const { sql } = await import("@codemirror/lang-sql");
			return sql();
		}
		case "php": {
			const { php } = await import("@codemirror/lang-php");
			return php();
		}
		case "java": {
			const { java } = await import("@codemirror/lang-java");
			return java();
		}
		case "c":
		case "cpp": {
			const { cpp } = await import("@codemirror/lang-cpp");
			return cpp();
		}
		case "go": {
			const { go } = await import("@codemirror/lang-go");
			return go();
		}
		case "shell":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/shell"),
				"shell",
			);
		case "dockerfile":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/dockerfile"),
				"dockerFile",
			);
		case "makefile":
			return StreamLanguage.define(makefileStreamLanguage);
		case "toml":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/toml"),
				"toml",
			);
		case "dart":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/clike"),
				"dart",
			);
		case "ruby":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/ruby"),
				"ruby",
			);
		case "swift":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/swift"),
				"swift",
			);
		case "csharp":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/clike"),
				"csharp",
			);
		case "kotlin":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/clike"),
				"kotlin",
			);
		case "dotenv":
			return loadLegacyLanguage(
				() => import("@codemirror/legacy-modes/mode/properties"),
				"properties",
			);
		case "csv":
			return StreamLanguage.define(csvStreamLanguage);
		case "tsv":
			return StreamLanguage.define(tsvStreamLanguage);
		default:
			return null;
	}
}
