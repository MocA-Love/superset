import { appState } from "main/lib/app-state";
import type { TabsState, ThemeState } from "main/lib/app-state/schemas";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Zod schema for FileViewerState persistence.
 * Note: initialLine/initialColumn from shared/tabs-types.ts are intentionally
 * omitted as they are transient (applied once on open, not persisted).
 */
const fileViewerStateSchema = z.object({
	filePath: z.string(),
	viewMode: z.enum(["rendered", "raw", "diff", "conflict"]),
	isPinned: z.boolean(),
	diffLayout: z.enum(["inline", "side-by-side"]),
	diffCategory: z
		.enum(["against-base", "committed", "staged", "unstaged", "conflicted"])
		.optional(),
	commitHash: z.string().optional(),
	oldPath: z.string().optional(),
});

const chatLaunchConfigSchema = z.object({
	initialPrompt: z.string().optional(),
	metadata: z
		.object({
			model: z.string().optional(),
		})
		.optional(),
	retryCount: z.number().int().min(0).optional(),
});

/**
 * Zod schema for Pane
 */
const paneSchema = z.object({
	id: z.string(),
	tabId: z.string(),
	type: z.enum([
		"terminal",
		"webview",
		"file-viewer",
		"chat",
		"devtools",
		"git-graph",
		"database-explorer",
		"action-logs",
		"vscode-extension",
		"reference-graph",
	]),
	name: z.string(),
	isNew: z.boolean().optional(),
	status: z.enum(["idle", "working", "permission", "review"]).optional(),
	initialCwd: z.string().optional(),
	url: z.string().optional(),
	cwd: z.string().nullable().optional(),
	cwdConfirmed: z.boolean().optional(),
	fileViewer: fileViewerStateSchema.optional(),
	chat: z
		.object({
			sessionId: z.string().nullable(),
			launchConfig: chatLaunchConfigSchema.nullable().optional(),
		})
		.optional(),
	browser: z
		.object({
			currentUrl: z.string(),
			history: z.array(
				z.object({
					url: z.string(),
					title: z.string(),
					timestamp: z.number(),
					faviconUrl: z.string().optional(),
				}),
			),
			historyIndex: z.number(),
			isLoading: z.boolean(),
			viewport: z
				.object({
					name: z.string(),
					width: z.number(),
					height: z.number(),
				})
				.nullable()
				.optional(),
		})
		.optional(),
	devtools: z
		.object({
			targetPaneId: z.string(),
		})
		.optional(),
	databaseExplorer: z
		.object({
			connectionId: z.string().nullable(),
		})
		.optional(),
	actionLogs: z
		.object({
			jobs: z.array(
				z.object({
					detailsUrl: z.string(),
					name: z.string(),
					status: z.enum([
						"success",
						"failure",
						"pending",
						"skipped",
						"cancelled",
					]),
				}),
			),
			initialJobIndex: z.number().optional(),
		})
		.optional(),
	vscodeExtension: z
		.object({
			viewType: z.string(),
			extensionId: z.string(),
			source: z.enum(["view", "panel"]).optional(),
			sessionId: z.string().optional(),
		})
		.optional(),
	gitGraph: z
		.object({
			worktreePath: z.string(),
		})
		.optional(),
	referenceGraph: z
		.object({
			absolutePath: z.string(),
			languageId: z.string(),
			line: z.number(),
			column: z.number(),
		})
		.optional(),
	workspaceRun: z
		.object({
			workspaceId: z.string(),
			state: z.enum(["running", "stopped-by-user", "stopped-by-exit"]),
		})
		.optional(),
});

/**
 * Zod schema for MosaicNode<string> (recursive tree structure for pane layouts)
 */
type MosaicNode =
	| string
	| {
			direction: "row" | "column";
			first: MosaicNode;
			second: MosaicNode;
			splitPercentage?: number;
	  };
const mosaicNodeSchema: z.ZodType<MosaicNode> = z.lazy(() =>
	z.union([
		z.string(), // Leaf node (paneId)
		z.object({
			direction: z.enum(["row", "column"]),
			first: mosaicNodeSchema,
			second: mosaicNodeSchema,
			splitPercentage: z.number().optional(),
		}),
	]),
);

/**
 * Zod schema for Tab (extends BaseTab with layout)
 */
const tabSchema = z.object({
	id: z.string(),
	name: z.string(),
	userTitle: z.string().optional(),
	workspaceId: z.string(),
	createdAt: z.number(),
	layout: mosaicNodeSchema,
});

/**
 * Zod schema for TabsState
 */
const tabsStateSchema = z.object({
	tabs: z.array(tabSchema),
	panes: z.record(z.string(), paneSchema),
	activeTabIds: z.record(z.string(), z.string().nullable()),
	focusedPaneIds: z.record(z.string(), z.string()),
	tabHistoryStacks: z.record(z.string(), z.array(z.string())),
});

/**
 * Zod schema for UI colors
 */
const uiColorsSchema = z.object({
	background: z.string(),
	foreground: z.string(),
	card: z.string(),
	cardForeground: z.string(),
	popover: z.string(),
	popoverForeground: z.string(),
	primary: z.string(),
	primaryForeground: z.string(),
	secondary: z.string(),
	secondaryForeground: z.string(),
	muted: z.string(),
	mutedForeground: z.string(),
	accent: z.string(),
	accentForeground: z.string(),
	tertiary: z.string(),
	tertiaryActive: z.string(),
	destructive: z.string(),
	destructiveForeground: z.string(),
	border: z.string(),
	input: z.string(),
	ring: z.string(),
	sidebar: z.string(),
	sidebarForeground: z.string(),
	sidebarPrimary: z.string(),
	sidebarPrimaryForeground: z.string(),
	sidebarAccent: z.string(),
	sidebarAccentForeground: z.string(),
	sidebarBorder: z.string(),
	sidebarRing: z.string(),
	chart1: z.string(),
	chart2: z.string(),
	chart3: z.string(),
	chart4: z.string(),
	chart5: z.string(),
	highlightMatch: z.string(),
	highlightActive: z.string(),
});

/**
 * Zod schema for terminal colors
 */
const terminalColorsSchema = z.object({
	background: z.string(),
	foreground: z.string(),
	cursor: z.string(),
	cursorAccent: z.string().optional(),
	selectionBackground: z.string().optional(),
	selectionForeground: z.string().optional(),
	black: z.string(),
	red: z.string(),
	green: z.string(),
	yellow: z.string(),
	blue: z.string(),
	magenta: z.string(),
	cyan: z.string(),
	white: z.string(),
	brightBlack: z.string(),
	brightRed: z.string(),
	brightGreen: z.string(),
	brightYellow: z.string(),
	brightBlue: z.string(),
	brightMagenta: z.string(),
	brightCyan: z.string(),
	brightWhite: z.string(),
});

/**
 * Zod schema for editor chrome colors.
 * Mirrors EditorColors in shared/themes/types.ts.
 */
const editorColorsSchema = z.object({
	background: z.string(),
	foreground: z.string(),
	border: z.string(),
	cursor: z.string(),
	gutterBackground: z.string(),
	gutterForeground: z.string(),
	activeLine: z.string(),
	selection: z.string(),
	search: z.string(),
	searchActive: z.string(),
	panel: z.string(),
	panelBorder: z.string(),
	panelInputBackground: z.string(),
	panelInputForeground: z.string(),
	panelInputBorder: z.string(),
	panelButtonBackground: z.string(),
	panelButtonForeground: z.string(),
	panelButtonBorder: z.string(),
	diffBuffer: z.string(),
	diffHover: z.string(),
	diffSeparator: z.string(),
	addition: z.string(),
	deletion: z.string(),
	modified: z.string(),
});

/**
 * Zod schema for editor syntax colors.
 * Mirrors EditorSyntaxColors in shared/themes/types.ts.
 */
const editorSyntaxColorsSchema = z.object({
	plainText: z.string(),
	comment: z.string(),
	docComment: z.string(),
	keyword: z.string(),
	controlKeyword: z.string(),
	storageKeyword: z.string(),
	string: z.string(),
	escape: z.string(),
	number: z.string(),
	functionCall: z.string(),
	variableName: z.string(),
	variableProperty: z.string(),
	typeName: z.string(),
	className: z.string(),
	constant: z.string(),
	regexp: z.string(),
	tagName: z.string(),
	attributeName: z.string(),
	invalid: z.string(),
	annotation: z.string(),
	operator: z.string(),
	punctuation: z.string(),
	markdownHeading: z.string(),
	markdownEmphasis: z.string(),
	markdownStrong: z.string(),
	markdownStrikethrough: z.string(),
	markdownLink: z.string(),
	markdownUrl: z.string(),
	markdownCode: z.string(),
	markdownQuote: z.string(),
	markdownList: z.string(),
	markdownSeparator: z.string(),
	meta: z.string(),
});

/**
 * Zod schema for EditorThemeOverrides.
 * Both `colors` and `syntax` accept partial shapes so imported themes that
 * only override a subset of tokens still round-trip through persistence.
 */
const editorThemeOverridesSchema = z.object({
	colors: editorColorsSchema.partial().optional(),
	syntax: editorSyntaxColorsSchema.partial().optional(),
});

/**
 * Zod schema for Theme.
 *
 * `terminal` and `editor` are optional to match the Theme interface in
 * shared/themes/types.ts. If they are missing, the app falls back to
 * defaults derived from the theme type and base UI colors.
 *
 * Every field declared on the Theme interface MUST appear here — Zod's
 * default `z.object()` silently strips unknown keys during
 * `.input(...)` validation on the `theme.set` tRPC mutation, which
 * means any missing field would be dropped on every persist cycle and
 * lost after app restart.
 */
const themeSchema = z.object({
	id: z.string(),
	name: z.string(),
	author: z.string().optional(),
	version: z.string().optional(),
	description: z.string().optional(),
	type: z.enum(["dark", "light"]),
	ui: uiColorsSchema,
	terminal: terminalColorsSchema.optional(),
	editor: editorThemeOverridesSchema.optional(),
	isBuiltIn: z.boolean().optional(),
	isCustom: z.boolean().optional(),
});

/**
 * Zod schema for ThemeState
 */
const themeStateSchema = z.object({
	activeThemeId: z.string(),
	customThemes: z.array(themeSchema),
	systemLightThemeId: z.string().optional(),
	systemDarkThemeId: z.string().optional(),
});

export const __testing = {
	themeSchema,
	themeStateSchema,
};

/**
 * UI State router - manages tabs and theme persistence via lowdb
 */
export const createUiStateRouter = () => {
	return router({
		// Tabs state procedures
		tabs: router({
			get: publicProcedure.query((): TabsState => {
				return appState.data.tabsState;
			}),

			set: publicProcedure
				.input(tabsStateSchema)
				.mutation(async ({ input }) => {
					appState.data.tabsState = input;
					await appState.write();
					return { success: true };
				}),
		}),

		// Theme state procedures
		theme: router({
			get: publicProcedure.query((): ThemeState => {
				return appState.data.themeState;
			}),

			set: publicProcedure
				.input(themeStateSchema)
				.mutation(async ({ input }) => {
					appState.data.themeState = input;
					await appState.write();
					return { success: true };
				}),
		}),

		// Legacy hotkeys state (read-only, for one-time migration to localStorage)
		hotkeys: router({
			get: publicProcedure.query(() => {
				return appState.data.hotkeysState;
			}),
		}),
	});
};
