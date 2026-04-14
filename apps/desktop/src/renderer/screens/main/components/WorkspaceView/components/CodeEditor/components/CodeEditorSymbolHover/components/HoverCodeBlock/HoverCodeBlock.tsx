import { useEffect, useState } from "react";
import { highlightCode } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/ReferenceGraphPane/lib/highlighter";

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	dart: "dart",
	diff: "diff",
	go: "go",
	gql: "graphql",
	graphql: "graphql",
	html: "html",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	md: "markdown",
	mjs: "javascript",
	py: "python",
	python: "python",
	rs: "rust",
	rust: "rust",
	scss: "css",
	sh: "bash",
	shell: "bash",
	shellscript: "bash",
	sql: "sql",
	text: "plaintext",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	txt: "plaintext",
	xml: "html",
	yaml: "yaml",
	yml: "yaml",
};

const SHIKI_SUPPORTED_LANGUAGES = new Set([
	"bash",
	"cpp",
	"csharp",
	"css",
	"dart",
	"diff",
	"go",
	"graphql",
	"html",
	"java",
	"javascript",
	"json",
	"jsx",
	"markdown",
	"plaintext",
	"python",
	"rust",
	"sql",
	"toml",
	"tsx",
	"typescript",
	"yaml",
]);

interface HoverCodeBlockProps {
	code: string;
	language?: string;
	shikiTheme?: {
		name: string;
		type: string;
		colors: object;
		tokenColors: object[];
	};
}

function normalizeLanguage(language?: string): string | null {
	if (!language) {
		return null;
	}

	const normalized = language.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const resolved = SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized;
	return SHIKI_SUPPORTED_LANGUAGES.has(resolved) ? resolved : null;
}

export function HoverCodeBlock({
	code,
	language,
	shikiTheme,
}: HoverCodeBlockProps) {
	const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
	const normalizedLanguage = normalizeLanguage(language);

	useEffect(() => {
		let cancelled = false;

		if (!normalizedLanguage) {
			setHighlightedHtml(null);
			return;
		}

		void highlightCode(code, normalizedLanguage, shikiTheme)
			.then((html) => {
				if (!cancelled) {
					setHighlightedHtml(html);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setHighlightedHtml(null);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [code, normalizedLanguage, shikiTheme]);

	if (highlightedHtml) {
		return (
			<div className="cm-superset-symbol-hover-code-block">
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates trusted HTML */}
				<div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
			</div>
		);
	}

	return (
		<pre className="cm-superset-symbol-hover-code-block">
			<code>{code}</code>
		</pre>
	);
}
