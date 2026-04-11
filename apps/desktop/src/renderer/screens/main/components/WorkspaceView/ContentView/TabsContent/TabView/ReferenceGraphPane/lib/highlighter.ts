import {
	type BundledLanguage,
	createHighlighter,
	type Highlighter,
} from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

const SUPPORTED_LANGUAGES: BundledLanguage[] = [
	"typescript",
	"javascript",
	"tsx",
	"jsx",
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"ruby",
	"php",
	"swift",
	"kotlin",
	"vue",
	"html",
	"css",
	"json",
	"yaml",
	"markdown",
];

export async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ["dark-plus"],
			langs: SUPPORTED_LANGUAGES,
		});
	}
	return highlighterPromise;
}

export async function highlightCode(
	code: string,
	language: string,
): Promise<string> {
	const highlighter = await getHighlighter();

	const safeLanguage = SUPPORTED_LANGUAGES.includes(language as BundledLanguage)
		? (language as BundledLanguage)
		: "typescript";

	return highlighter.codeToHtml(code, {
		lang: safeLanguage,
		theme: "dark-plus",
	});
}
