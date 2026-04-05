import { z } from "zod";
import { builtInThemes, darkTheme, lightTheme } from "./built-in";
import { getEditorTheme } from "./editor-theme";
import { getDefaultTerminalColors, type Theme } from "./types";

const uiColorsSchema = z
	.object({
		background: z.string().optional(),
		foreground: z.string().optional(),
		card: z.string().optional(),
		cardForeground: z.string().optional(),
		popover: z.string().optional(),
		popoverForeground: z.string().optional(),
		primary: z.string().optional(),
		primaryForeground: z.string().optional(),
		secondary: z.string().optional(),
		secondaryForeground: z.string().optional(),
		muted: z.string().optional(),
		mutedForeground: z.string().optional(),
		accent: z.string().optional(),
		accentForeground: z.string().optional(),
		tertiary: z.string().optional(),
		tertiaryActive: z.string().optional(),
		destructive: z.string().optional(),
		destructiveForeground: z.string().optional(),
		border: z.string().optional(),
		input: z.string().optional(),
		ring: z.string().optional(),
		sidebar: z.string().optional(),
		sidebarForeground: z.string().optional(),
		sidebarPrimary: z.string().optional(),
		sidebarPrimaryForeground: z.string().optional(),
		sidebarAccent: z.string().optional(),
		sidebarAccentForeground: z.string().optional(),
		sidebarBorder: z.string().optional(),
		sidebarRing: z.string().optional(),
		chart1: z.string().optional(),
		chart2: z.string().optional(),
		chart3: z.string().optional(),
		chart4: z.string().optional(),
		chart5: z.string().optional(),
		highlightMatch: z.string().optional(),
		highlightActive: z.string().optional(),
	})
	.passthrough();

const terminalColorsSchema = z
	.object({
		background: z.string().optional(),
		foreground: z.string().optional(),
		cursor: z.string().optional(),
		cursorAccent: z.string().optional(),
		selectionBackground: z.string().optional(),
		selectionForeground: z.string().optional(),
		black: z.string().optional(),
		red: z.string().optional(),
		green: z.string().optional(),
		yellow: z.string().optional(),
		blue: z.string().optional(),
		magenta: z.string().optional(),
		cyan: z.string().optional(),
		white: z.string().optional(),
		brightBlack: z.string().optional(),
		brightRed: z.string().optional(),
		brightGreen: z.string().optional(),
		brightYellow: z.string().optional(),
		brightBlue: z.string().optional(),
		brightMagenta: z.string().optional(),
		brightCyan: z.string().optional(),
		brightWhite: z.string().optional(),
	})
	.passthrough();

const editorColorsSchema = z
	.object({
		background: z.string().optional(),
		foreground: z.string().optional(),
		border: z.string().optional(),
		cursor: z.string().optional(),
		gutterBackground: z.string().optional(),
		gutterForeground: z.string().optional(),
		activeLine: z.string().optional(),
		selection: z.string().optional(),
		search: z.string().optional(),
		searchActive: z.string().optional(),
		panel: z.string().optional(),
		panelBorder: z.string().optional(),
		panelInputBackground: z.string().optional(),
		panelInputForeground: z.string().optional(),
		panelInputBorder: z.string().optional(),
		panelButtonBackground: z.string().optional(),
		panelButtonForeground: z.string().optional(),
		panelButtonBorder: z.string().optional(),
		diffBuffer: z.string().optional(),
		diffHover: z.string().optional(),
		diffSeparator: z.string().optional(),
		addition: z.string().optional(),
		deletion: z.string().optional(),
		modified: z.string().optional(),
	})
	.passthrough();

const editorSyntaxSchema = z
	.object({
		plainText: z.string().optional(),
		comment: z.string().optional(),
		keyword: z.string().optional(),
		string: z.string().optional(),
		number: z.string().optional(),
		functionCall: z.string().optional(),
		variableName: z.string().optional(),
		typeName: z.string().optional(),
		className: z.string().optional(),
		constant: z.string().optional(),
		regexp: z.string().optional(),
		tagName: z.string().optional(),
		attributeName: z.string().optional(),
		invalid: z.string().optional(),
		operator: z.string().optional(),
		punctuation: z.string().optional(),
		markdownHeading: z.string().optional(),
		markdownEmphasis: z.string().optional(),
		markdownStrong: z.string().optional(),
		markdownStrikethrough: z.string().optional(),
		markdownLink: z.string().optional(),
		markdownUrl: z.string().optional(),
		markdownCode: z.string().optional(),
		markdownQuote: z.string().optional(),
		markdownList: z.string().optional(),
		markdownSeparator: z.string().optional(),
		meta: z.string().optional(),
	})
	.passthrough();

const editorThemeSchema = z
	.object({
		colors: editorColorsSchema.optional(),
		syntax: editorSyntaxSchema.optional(),
	})
	.passthrough();

const themeConfigSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().optional(),
		author: z.string().optional(),
		version: z.string().optional(),
		description: z.string().optional(),
		type: z.enum(["dark", "light"]).optional(),
		ui: uiColorsSchema.optional(),
		terminal: terminalColorsSchema.optional(),
		colors: terminalColorsSchema.optional(),
		editor: editorThemeSchema.optional(),
	})
	.passthrough();

const RESERVED_THEME_IDS = new Set([
	"system",
	...builtInThemes.map((theme) => theme.id),
]);

function normalizeThemeId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function isThemePack(value: unknown): value is {
	themes: unknown[];
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"themes" in value &&
		Array.isArray((value as { themes?: unknown[] }).themes)
	);
}

// ── VS Code theme format detection & conversion ──────────────

interface VsCodeTokenColor {
	scope?: string | string[];
	settings?: { foreground?: string; fontStyle?: string };
}

function isVsCodeTheme(value: unknown): value is {
	name?: string;
	type?: string;
	tokenColors?: VsCodeTokenColor[];
	colors?: Record<string, string>;
	semanticHighlighting?: boolean;
	semanticTokenColors?: Record<string, unknown>;
} {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return Array.isArray(obj.tokenColors);
}

/**
 * Scope-to-EditorSyntaxColors mapping.
 * Order matters: more specific scopes should come first.
 * The first matching scope wins for each syntax key.
 */
const SCOPE_TO_SYNTAX: Array<{
	key: string;
	scopes: string[];
}> = [
	// Markdown (specific scopes first)
	{
		key: "markdownHeading",
		scopes: [
			"markup.heading",
			"entity.name.section",
			"punctuation.definition.heading",
		],
	},
	{
		key: "markdownStrong",
		scopes: ["markup.bold", "punctuation.definition.bold"],
	},
	{
		key: "markdownEmphasis",
		scopes: ["markup.italic", "punctuation.definition.italic"],
	},
	{ key: "markdownStrikethrough", scopes: ["markup.strikethrough"] },
	{
		key: "markdownLink",
		scopes: [
			"markup.underline.link",
			"string.other.link.title",
			"string.other.link.description",
		],
	},
	{
		key: "markdownUrl",
		scopes: ["markup.underline.link.image"],
	},
	{
		key: "markdownCode",
		scopes: ["markup.inline.raw", "markup.fenced_code", "markup.raw"],
	},
	{ key: "markdownQuote", scopes: ["markup.quote"] },
	{
		key: "markdownList",
		scopes: [
			"punctuation.definition.list",
			"beginning.punctuation.definition.list",
		],
	},
	// Code tokens
	{
		key: "comment",
		scopes: ["comment", "punctuation.definition.comment"],
	},
	{
		key: "keyword",
		scopes: ["keyword", "keyword.control", "storage", "storage.type"],
	},
	{ key: "string", scopes: ["string"] },
	{
		key: "number",
		scopes: ["constant.numeric", "constant.language"],
	},
	{
		key: "functionCall",
		scopes: [
			"entity.name.function",
			"support.function",
			"meta.function-call",
			"variable.function",
		],
	},
	{ key: "variableName", scopes: ["variable"] },
	{
		key: "typeName",
		scopes: ["entity.name.type", "support.type", "support.class"],
	},
	{
		key: "className",
		scopes: ["entity.name.class", "entity.other.inherited-class"],
	},
	{ key: "constant", scopes: ["constant", "support.constant"] },
	{ key: "regexp", scopes: ["string.regexp"] },
	{
		key: "tagName",
		scopes: ["entity.name.tag", "punctuation.definition.tag"],
	},
	{
		key: "attributeName",
		scopes: ["entity.other.attribute-name"],
	},
	{ key: "invalid", scopes: ["invalid"] },
	{
		key: "operator",
		scopes: ["keyword.operator"],
	},
	{
		key: "punctuation",
		scopes: ["punctuation", "meta.brace", "meta.bracket"],
	},
	{ key: "meta", scopes: ["meta.tag", "meta.selector"] },
];

/**
 * VS Code `colors` key → Superset UIColors key.
 */
const VSCODE_COLORS_TO_UI: Record<string, string> = {
	"editor.background": "background",
	"editor.foreground": "foreground",
	"editorWidget.background": "card",
	"editorWidget.foreground": "cardForeground",
	"editorHoverWidget.background": "popover",
	"editorHoverWidget.foreground": "popoverForeground",
	"button.background": "primary",
	"button.foreground": "primaryForeground",
	"button.secondaryBackground": "secondary",
	"button.secondaryForeground": "secondaryForeground",
	"tab.inactiveBackground": "muted",
	"editorLineNumber.foreground": "mutedForeground",
	"list.hoverBackground": "accent",
	"list.activeSelectionForeground": "accentForeground",
	"editorGroup.border": "border",
	"input.background": "input",
	focusBorder: "ring",
	"sideBar.background": "sidebar",
	"sideBar.foreground": "sidebarForeground",
	"sideBarTitle.foreground": "sidebarForeground",
	"activityBar.foreground": "sidebarPrimary",
	"activityBarBadge.foreground": "sidebarPrimaryForeground",
	"sideBarSectionHeader.background": "sidebarAccent",
	"sideBarSectionHeader.foreground": "sidebarAccentForeground",
	"sideBar.border": "sidebarBorder",
	"editorError.foreground": "destructive",
};

/**
 * VS Code `colors` key → Superset TerminalColors key.
 */
const VSCODE_COLORS_TO_TERMINAL: Record<string, string> = {
	"terminal.background": "background",
	"terminal.foreground": "foreground",
	"terminalCursor.foreground": "cursor",
	"terminalCursor.background": "cursorAccent",
	"terminal.selectionBackground": "selectionBackground",
	"terminal.ansiBlack": "black",
	"terminal.ansiRed": "red",
	"terminal.ansiGreen": "green",
	"terminal.ansiYellow": "yellow",
	"terminal.ansiBlue": "blue",
	"terminal.ansiMagenta": "magenta",
	"terminal.ansiCyan": "cyan",
	"terminal.ansiWhite": "white",
	"terminal.ansiBrightBlack": "brightBlack",
	"terminal.ansiBrightRed": "brightRed",
	"terminal.ansiBrightGreen": "brightGreen",
	"terminal.ansiBrightYellow": "brightYellow",
	"terminal.ansiBrightBlue": "brightBlue",
	"terminal.ansiBrightMagenta": "brightMagenta",
	"terminal.ansiBrightCyan": "brightCyan",
	"terminal.ansiBrightWhite": "brightWhite",
};

/**
 * VS Code `colors` key → Superset EditorColors key.
 */
const VSCODE_COLORS_TO_EDITOR: Record<string, string> = {
	"editor.background": "background",
	"editor.foreground": "foreground",
	"editorGroup.border": "border",
	"editorCursor.foreground": "cursor",
	"editorGutter.background": "gutterBackground",
	"editorLineNumber.foreground": "gutterForeground",
	"editor.lineHighlightBackground": "activeLine",
	"editor.selectionBackground": "selection",
	"editor.findMatchHighlightBackground": "search",
	"editor.findMatchBackground": "searchActive",
	"diffEditor.insertedTextBackground": "addition",
	"diffEditor.removedTextBackground": "deletion",
};

/**
 * Extract the foreground color for a given scope from VS Code tokenColors.
 * Uses prefix matching: scope "keyword.control" matches pattern "keyword".
 */
function findColorForScope(
	tokenColors: VsCodeTokenColor[],
	pattern: string,
): string | undefined {
	// Search in reverse so later (more specific) entries win
	for (let i = tokenColors.length - 1; i >= 0; i--) {
		const entry = tokenColors[i];
		if (!entry.settings?.foreground) continue;

		const scopes = Array.isArray(entry.scope)
			? entry.scope
			: typeof entry.scope === "string"
				? entry.scope.split(",").map((s) => s.trim())
				: [];

		for (const scope of scopes) {
			if (scope === pattern || scope.startsWith(`${pattern}.`)) {
				return entry.settings.foreground;
			}
		}
	}
	return undefined;
}

/**
 * Convert a VS Code theme (with tokenColors/colors) to Superset format.
 */
function convertVsCodeTheme(vscode: {
	name?: string;
	type?: string;
	tokenColors?: VsCodeTokenColor[];
	colors?: Record<string, string>;
}): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (vscode.name) result.name = vscode.name;
	result.type = vscode.type === "light" ? "light" : "dark";

	const tokenColors = vscode.tokenColors ?? [];
	const vsColors = vscode.colors ?? {};

	// ── Extract UI colors from VS Code colors ──
	const ui: Record<string, string> = {};
	for (const [vsKey, supersetKey] of Object.entries(VSCODE_COLORS_TO_UI)) {
		const value = vsColors[vsKey];
		if (value) ui[supersetKey] = value;
	}
	if (Object.keys(ui).length > 0) result.ui = ui;

	// ── Extract terminal colors ──
	const terminal: Record<string, string> = {};
	for (const [vsKey, supersetKey] of Object.entries(
		VSCODE_COLORS_TO_TERMINAL,
	)) {
		const value = vsColors[vsKey];
		if (value) terminal[supersetKey] = value;
	}
	if (Object.keys(terminal).length > 0) result.terminal = terminal;

	// ── Extract editor colors ──
	const editorColors: Record<string, string> = {};
	for (const [vsKey, supersetKey] of Object.entries(VSCODE_COLORS_TO_EDITOR)) {
		const value = vsColors[vsKey];
		if (value) editorColors[supersetKey] = value;
	}

	// ── Extract syntax colors from tokenColors ──
	const syntax: Record<string, string> = {};
	for (const { key, scopes } of SCOPE_TO_SYNTAX) {
		if (syntax[key]) continue; // already found by a more specific rule
		for (const scope of scopes) {
			const color = findColorForScope(tokenColors, scope);
			if (color) {
				syntax[key] = color;
				break;
			}
		}
	}

	// ── Build editor override ──
	const hasEditorColors = Object.keys(editorColors).length > 0;
	const hasSyntax = Object.keys(syntax).length > 0;
	if (hasEditorColors || hasSyntax) {
		result.editor = {
			...(hasEditorColors ? { colors: editorColors } : {}),
			...(hasSyntax ? { syntax } : {}),
		};
	}

	return result;
}

function parseThemeEntry(
	entry: unknown,
	index: number,
): { ok: true; theme: Theme } | { ok: false; issue: string } {
	const parsedEntry = themeConfigSchema.safeParse(entry);
	if (!parsedEntry.success) {
		const issue = parsedEntry.error.issues[0]?.message ?? "Invalid theme shape";
		return { ok: false, issue: `Theme ${index + 1}: ${issue}` };
	}

	const config = parsedEntry.data;
	const rawName = config.name?.trim();
	const rawId = config.id?.trim() ?? rawName;
	if (!rawId) {
		return {
			ok: false,
			issue: `Theme ${index + 1}: Missing required "id" or "name"`,
		};
	}

	const id = normalizeThemeId(rawId);
	if (!id) {
		return {
			ok: false,
			issue: `Theme ${index + 1}: Theme ID resolved to empty value`,
		};
	}

	if (RESERVED_THEME_IDS.has(id)) {
		return {
			ok: false,
			issue: `Theme ${index + 1}: "${id}" is reserved by Superset`,
		};
	}

	const type = config.type ?? "dark";
	const baseTheme = type === "light" ? lightTheme : darkTheme;
	const terminalOverrides = config.terminal ?? config.colors;
	const editorOverrides = config.editor;
	const resolvedThemeBase: Theme = {
		id,
		name: rawName || config.id || id,
		author: config.author,
		version: config.version,
		description: config.description,
		type,
		ui: {
			...baseTheme.ui,
			...(config.ui ?? {}),
		},
		terminal: terminalOverrides
			? {
					...getDefaultTerminalColors(type),
					...terminalOverrides,
				}
			: undefined,
	};
	const baseEditorTheme = getEditorTheme(resolvedThemeBase);

	return {
		ok: true,
		theme: {
			...resolvedThemeBase,
			terminal: terminalOverrides
				? {
						...getDefaultTerminalColors(type),
						...terminalOverrides,
					}
				: undefined,
			editor: editorOverrides
				? {
						colors: {
							...baseEditorTheme.colors,
							...(editorOverrides.colors ?? {}),
						},
						syntax: {
							...baseEditorTheme.syntax,
							...(editorOverrides.syntax ?? {}),
						},
					}
				: undefined,
		},
	};
}

export type ThemeConfigParseResult =
	| { ok: false; error: string }
	| { ok: true; themes: Theme[]; issues: string[] };

/**
 * Parse user-supplied theme config JSON.
 * Supports:
 * - a single theme object
 * - an array of theme objects
 * - an object with `{ themes: [...] }`
 */
export function parseThemeConfigFile(content: string): ThemeConfigParseResult {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(content);
	} catch {
		return { ok: false, error: "Invalid JSON file" };
	}

	// VS Code theme format: convert tokenColors/colors to Superset format
	if (isVsCodeTheme(parsedJson)) {
		parsedJson = convertVsCodeTheme(parsedJson);
	}

	const entries = Array.isArray(parsedJson)
		? parsedJson
		: isThemePack(parsedJson)
			? parsedJson.themes
			: [parsedJson];

	if (entries.length === 0) {
		return { ok: false, error: "No themes found in file" };
	}

	const themes: Theme[] = [];
	const issues: string[] = [];

	for (const [index, entry] of entries.entries()) {
		const parsedEntry = parseThemeEntry(entry, index);
		if (!parsedEntry.ok) {
			issues.push(parsedEntry.issue);
			continue;
		}
		themes.push(parsedEntry.theme);
	}

	if (themes.length === 0) {
		return {
			ok: false,
			error: issues[0] ?? "No valid themes found in file",
		};
	}

	return { ok: true, themes, issues };
}
