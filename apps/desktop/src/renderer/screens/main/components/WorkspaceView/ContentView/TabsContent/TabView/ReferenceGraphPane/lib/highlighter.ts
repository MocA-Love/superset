import {
	type BundledLanguage,
	createHighlighter,
	type Highlighter,
} from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

const SHIKI_LANGUAGE_ALIASES: Record<string, string | null> = {
	"c#": "csharp",
	cs: "csharp",
	cjs: "javascript",
	cts: "typescript",
	gql: "graphql",
	htm: "html",
	js: "javascript",
	javascriptreact: "jsx",
	jsx: "jsx",
	md: "markdown",
	mjs: "javascript",
	mts: "typescript",
	py: "python",
	plaintext: null,
	rs: "rust",
	scss: "scss",
	sh: "shellscript",
	shellscript: "shellscript",
	text: null,
	ts: "typescript",
	typescriptreact: "tsx",
	txt: null,
	yml: "yaml",
};

function normalizeShikiLanguage(language: string): string | null {
	const normalized = language.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	return SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized;
}

async function ensureLanguageLoaded(
	highlighter: Highlighter,
	language: string,
): Promise<BundledLanguage> {
	const normalized = normalizeShikiLanguage(language);
	if (!normalized) {
		throw new Error("No Shiki language provided");
	}

	if (
		!highlighter.getLoadedLanguages().includes(normalized as BundledLanguage)
	) {
		await highlighter.loadLanguage(normalized as BundledLanguage);
	}

	return normalized as BundledLanguage;
}

async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ["dark-plus"],
			langs: [],
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
	const safeLanguage = await ensureLanguageLoaded(highlighter, language);

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
