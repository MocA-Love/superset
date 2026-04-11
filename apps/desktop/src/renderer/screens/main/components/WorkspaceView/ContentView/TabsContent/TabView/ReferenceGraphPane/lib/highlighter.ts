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

async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ["dark-plus"],
			langs: SUPPORTED_LANGUAGES,
		});
	}
	return highlighterPromise;
}

/**
 * Highlight code using the app's active theme.
 * @param shikiTheme - The theme object from createShikiTheme(). If provided,
 *   the theme is registered dynamically and used for highlighting.
 *   Falls back to "dark-plus" if not provided.
 */
export async function highlightCode(
	code: string,
	language: string,
	shikiTheme?: {
		name: string;
		type: string;
		colors: object;
		tokenColors: object[];
	},
): Promise<string> {
	const highlighter = await getHighlighter();

	const safeLanguage = SUPPORTED_LANGUAGES.includes(language as BundledLanguage)
		? (language as BundledLanguage)
		: "typescript";

	let themeName = "dark-plus";

	if (shikiTheme) {
		// Register the app theme dynamically if not already loaded
		const loadedThemes = highlighter.getLoadedThemes();
		if (!loadedThemes.includes(shikiTheme.name)) {
			// biome-ignore lint/suspicious/noExplicitAny: shiki theme registration accepts dynamic shapes
			await highlighter.loadTheme(shikiTheme as any);
		}
		themeName = shikiTheme.name;
	}

	return highlighter.codeToHtml(code, {
		lang: safeLanguage,
		theme: themeName,
	});
}
