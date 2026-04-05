import {
	LanguageDescription,
	LanguageSupport,
	StreamLanguage,
	type StreamParser,
} from "@codemirror/language";
import {
	csvStreamLanguage,
	graphqlStreamLanguage,
	makefileStreamLanguage,
	tsvStreamLanguage,
} from "./streamLanguages";

async function loadLegacyLanguage(
	loader: () => Promise<Record<string, unknown>>,
	key: string,
): Promise<LanguageSupport> {
	const languageModule = await loader();
	const lang = StreamLanguage.define(
		languageModule[key] as StreamParser<unknown>,
	);
	return new LanguageSupport(lang);
}

export async function loadLanguageSupport(
	language: string,
): Promise<LanguageSupport | null> {
	switch (language) {
		case "typescript":
		case "javascript": {
			const { javascript } = await import("@codemirror/lang-javascript");
			return javascript({
				typescript: language === "typescript",
				jsx: true,
			});
		}
		case "json":
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
			return new LanguageSupport(StreamLanguage.define(graphqlStreamLanguage));
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
			return new LanguageSupport(StreamLanguage.define(makefileStreamLanguage));
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
			return new LanguageSupport(StreamLanguage.define(csvStreamLanguage));
		case "tsv":
			return new LanguageSupport(StreamLanguage.define(tsvStreamLanguage));
		default:
			return null;
	}
}

/**
 * Languages available for nested highlighting inside Markdown fenced code blocks.
 * Each entry delegates to loadLanguageSupport so there is a single source of truth.
 */
const MARKDOWN_NESTED_LANGUAGES: Array<{ name: string; alias?: string[] }> = [
	{ name: "javascript", alias: ["js", "jsx", "mjs", "cjs"] },
	{ name: "typescript", alias: ["ts", "tsx"] },
	{ name: "json", alias: ["jsonc"] },
	{ name: "html", alias: ["htm"] },
	{ name: "css", alias: ["scss", "less"] },
	{ name: "python", alias: ["py"] },
	{ name: "yaml", alias: ["yml"] },
	{ name: "xml" },
	{ name: "sql" },
	{ name: "rust", alias: ["rs"] },
	{ name: "java" },
	{ name: "cpp", alias: ["c", "h", "hpp"] },
	{ name: "go", alias: ["golang"] },
	{ name: "php" },
	{ name: "shell", alias: ["bash", "sh", "zsh"] },
	{ name: "dockerfile", alias: ["docker"] },
	{ name: "toml" },
	{ name: "ruby", alias: ["rb"] },
	{ name: "swift" },
];

const markdownCodeLanguages: LanguageDescription[] =
	MARKDOWN_NESTED_LANGUAGES.map(({ name, alias }) =>
		LanguageDescription.of({
			name,
			alias,
			async load() {
				const support = await loadLanguageSupport(name);
				return (
					support ??
					new LanguageSupport(
						StreamLanguage.define({
							token: (stream) => {
								stream.next();
								return null;
							},
						}),
					)
				);
			},
		}),
	);
