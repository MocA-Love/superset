/**
 * Maps Superset CSS variables to VS Code CSS variables.
 *
 * VS Code extensions' webviews depend on `--vscode-*` CSS variables
 * for styling. This module reads Superset's current theme and generates
 * a <style> block that defines the equivalent VS Code variables.
 */

/**
 * Mapping from VS Code CSS variable to Superset CSS variable (or fallback).
 * VS Code has ~200+ variables, but extensions typically use a subset.
 * This covers the most commonly used ones by Claude Code and ChatGPT.
 */
const VSCODE_TO_SUPERSET: Record<string, string> = {
	// Editor
	"--vscode-editor-background": "--background",
	"--vscode-editor-foreground": "--foreground",

	// Sidebar
	"--vscode-sideBar-background": "--sidebar",
	"--vscode-sideBar-foreground": "--sidebar-foreground",
	"--vscode-sideBar-border": "--sidebar-border",
	"--vscode-sideBarTitle-foreground": "--sidebar-foreground",
	"--vscode-sideBarSectionHeader-background": "--sidebar-accent",
	"--vscode-sideBarSectionHeader-foreground": "--sidebar-accent-foreground",

	// Panel
	"--vscode-panel-background": "--background",
	"--vscode-panel-foreground": "--foreground",
	"--vscode-panel-border": "--border",
	"--vscode-panelTitle-activeForeground": "--foreground",
	"--vscode-panelTitle-inactiveForeground": "--muted-foreground",

	// Input
	"--vscode-input-background": "--input",
	"--vscode-input-foreground": "--foreground",
	"--vscode-input-border": "--border",
	"--vscode-input-placeholderForeground": "--muted-foreground",
	"--vscode-inputOption-activeBorder": "--primary",
	"--vscode-inputOption-activeBackground": "--accent",
	"--vscode-inputOption-activeForeground": "--accent-foreground",

	// Button
	"--vscode-button-background": "--primary",
	"--vscode-button-foreground": "--primary-foreground",
	"--vscode-button-hoverBackground": "--primary",
	"--vscode-button-secondaryBackground": "--secondary",
	"--vscode-button-secondaryForeground": "--secondary-foreground",

	// Badge
	"--vscode-badge-background": "--primary",
	"--vscode-badge-foreground": "--primary-foreground",

	// Focus
	"--vscode-focusBorder": "--ring",

	// Text
	"--vscode-foreground": "--foreground",
	"--vscode-descriptionForeground": "--muted-foreground",
	"--vscode-disabledForeground": "--muted-foreground",
	"--vscode-errorForeground": "--destructive",

	// Widget
	"--vscode-widget-shadow": "--border",
	"--vscode-widget-border": "--border",

	// List
	"--vscode-list-hoverBackground": "--accent",
	"--vscode-list-hoverForeground": "--accent-foreground",
	"--vscode-list-activeSelectionBackground": "--primary",
	"--vscode-list-activeSelectionForeground": "--primary-foreground",
	"--vscode-list-inactiveSelectionBackground": "--secondary",
	"--vscode-list-inactiveSelectionForeground": "--secondary-foreground",

	// Dropdown
	"--vscode-dropdown-background": "--popover",
	"--vscode-dropdown-foreground": "--popover-foreground",
	"--vscode-dropdown-border": "--border",

	// Scrollbar
	"--vscode-scrollbarSlider-background": "--muted",
	"--vscode-scrollbarSlider-hoverBackground": "--accent",
	"--vscode-scrollbarSlider-activeBackground": "--accent",

	// TextLink
	"--vscode-textLink-foreground": "--primary",
	"--vscode-textLink-activeForeground": "--primary",

	// Checkbox
	"--vscode-checkbox-background": "--input",
	"--vscode-checkbox-border": "--border",
	"--vscode-checkbox-foreground": "--foreground",

	// Toolbar
	"--vscode-toolbar-hoverBackground": "--accent",

	// Tab
	"--vscode-tab-activeBackground": "--background",
	"--vscode-tab-activeForeground": "--foreground",
	"--vscode-tab-inactiveBackground": "--muted",
	"--vscode-tab-inactiveForeground": "--muted-foreground",
	"--vscode-tab-border": "--border",

	// Menu (Claude Code dropdown menus)
	"--vscode-menu-background": "--popover",
	"--vscode-menu-foreground": "--popover-foreground",
	"--vscode-menu-selectionBackground": "--accent",
	"--vscode-menu-selectionForeground": "--accent-foreground",
	"--vscode-menu-separatorBackground": "--border",
	"--vscode-menu-border": "--border",

	// Quick Input (command palette style)
	"--vscode-quickInput-background": "--popover",
	"--vscode-quickInput-foreground": "--popover-foreground",
	"--vscode-quickInputList-focusBackground": "--accent",
	"--vscode-quickInputList-focusForeground": "--accent-foreground",
	"--vscode-quickInputTitle-background": "--popover",

	// Command Center
	"--vscode-commandCenter-background": "--secondary",
	"--vscode-commandCenter-foreground": "--foreground",
	"--vscode-commandCenter-border": "--border",

	// Icon
	"--vscode-icon-foreground": "--foreground",

	// Keybinding
	"--vscode-keybindingLabel-foreground": "--foreground",
	"--vscode-keybindingLabel-background": "--secondary",
	"--vscode-keybindingLabel-border": "--border",

	// Notification
	"--vscode-notifications-background": "--card",
	"--vscode-notifications-foreground": "--card-foreground",
	"--vscode-notifications-border": "--border",
};

/**
 * Generates a CSS style block that maps Superset theme to VS Code variables.
 * Reads current computed CSS variable values from the document root.
 */
export function generateVscodeThemeCss(): string {
	const root = document.documentElement;
	const computedStyle = getComputedStyle(root);
	const isDark = root.classList.contains("dark");

	const lines: string[] = [];
	lines.push(":root {");

	// Map Superset variables to VS Code variables
	for (const [vscodeVar, supersetVar] of Object.entries(VSCODE_TO_SUPERSET)) {
		const value = computedStyle.getPropertyValue(supersetVar).trim();
		if (value) {
			// If the value looks like raw oklch channel values (e.g. "0.145 0 0"),
			// wrap it in oklch() so it's a valid CSS color
			const needsWrap = /^\d[\d.]*\s+[\d.]+\s+[\d.]+/.test(value);
			const cssValue = needsWrap ? `oklch(${value})` : value;
			lines.push(`  ${vscodeVar}: ${cssValue};`);
		}
	}

	// VS Code font variables
	lines.push(
		'  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
	);
	lines.push("  --vscode-font-size: 13px;");
	lines.push("  --vscode-font-weight: normal;");
	lines.push(
		'  --vscode-editor-font-family: "SF Mono", Monaco, Menlo, Consolas, monospace;',
	);
	lines.push("  --vscode-editor-font-size: 13px;");

	// Add VS Code-specific variables that have no Superset equivalent
	// These use VS Code Dark+/Light+ defaults based on current mode
	const defaults = isDark ? VSCODE_DARK_DEFAULTS : VSCODE_LIGHT_DEFAULTS;
	for (const [varName, value] of Object.entries(defaults)) {
		lines.push(`  ${varName}: ${value};`);
	}

	lines.push("}");

	// Dark/light body class for extensions that check it
	lines.push(`body { color-scheme: ${isDark ? "dark" : "light"}; }`);
	lines.push(`body.vscode-dark, body.vscode-light { margin: 0; padding: 0; }`);

	return lines.join("\n");
}

/**
 * VS Code Dark+ default values for variables without Superset equivalents.
 * Covers editor, diff, selection, symbol icons, charts used by Claude Code & Codex.
 */
const VSCODE_DARK_DEFAULTS: Record<string, string> = {
	// Editor selections & highlights
	"--vscode-editor-selectionBackground": "#264f78",
	"--vscode-editor-selectionForeground": "#ffffff",
	"--vscode-editor-inactiveSelectionBackground": "#3a3d41",
	"--vscode-editor-selectionHighlightBackground": "#add6ff26",
	"--vscode-editor-findMatchBackground": "#515c6a",
	"--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
	"--vscode-editor-findRangeHighlightBackground": "#3a3d4166",
	"--vscode-editor-hoverHighlightBackground": "#264f7840",
	"--vscode-editor-lineHighlightBackground": "#ffffff0a",
	"--vscode-editor-lineHighlightBorder": "#282828",
	"--vscode-editor-rangeHighlightBackground": "#ffffff0b",
	"--vscode-editor-wordHighlightBackground": "#575757b8",
	"--vscode-editor-wordHighlightStrongBackground": "#004972b8",
	// Editor UI
	"--vscode-editorCursor-foreground": "#aeafad",
	"--vscode-editorLineNumber-foreground": "#858585",
	"--vscode-editorLineNumber-activeForeground": "#c6c6c6",
	"--vscode-editorIndentGuide-background": "#404040",
	"--vscode-editorIndentGuide-activeBackground": "#707070",
	"--vscode-editorWhitespace-foreground": "#e3e4e229",
	"--vscode-editorRuler-foreground": "#5a5a5a",
	"--vscode-editorBracketMatch-background": "#0064001a",
	"--vscode-editorBracketMatch-border": "#888888",
	// Editor gutter
	"--vscode-editorGutter-addedBackground": "#587c0c",
	"--vscode-editorGutter-modifiedBackground": "#0c7d9d",
	"--vscode-editorGutter-deletedBackground": "#94151b",
	// Editor widget (hover, suggest, etc.)
	"--vscode-editorWidget-background": "#252526",
	"--vscode-editorWidget-foreground": "#cccccc",
	"--vscode-editorWidget-border": "#454545",
	"--vscode-editorSuggestWidget-background": "#252526",
	"--vscode-editorSuggestWidget-foreground": "#d4d4d4",
	"--vscode-editorSuggestWidget-selectedBackground": "#04395e",
	"--vscode-editorSuggestWidget-highlightForeground": "#18a3ff",
	"--vscode-editorHoverWidget-background": "#252526",
	"--vscode-editorHoverWidget-foreground": "#cccccc",
	"--vscode-editorHoverWidget-border": "#454545",
	// Diff editor
	"--vscode-diffEditor-insertedTextBackground": "#9bb95533",
	"--vscode-diffEditor-removedTextBackground": "#ff000033",
	"--vscode-diffEditor-insertedLineBackground": "#9bb95520",
	"--vscode-diffEditor-removedLineBackground": "#ff000020",
	"--vscode-diffEditorGutter-insertedLineBackground": "#587c0c",
	"--vscode-diffEditorGutter-removedLineBackground": "#94151b",
	"--vscode-diffEditorOverview-insertedForeground": "#587c0c80",
	"--vscode-diffEditorOverview-removedForeground": "#94151b80",
	// Error/Warning/Info
	"--vscode-editorError-foreground": "#f14c4c",
	"--vscode-editorWarning-foreground": "#cca700",
	"--vscode-editorInfo-foreground": "#3794ff",
	"--vscode-editorHint-foreground": "#eeeeeeb3",
	// Peek view
	"--vscode-peekView-border": "#007acc",
	"--vscode-peekViewEditor-background": "#001f33",
	"--vscode-peekViewResult-background": "#252526",
	"--vscode-peekViewTitle-background": "#1e1e1e",
	"--vscode-peekViewTitleLabel-foreground": "#ffffff",
	// Banner
	"--vscode-banner-background": "#04395e",
	"--vscode-banner-foreground": "#cccccc",
	"--vscode-banner-iconForeground": "#3794ff",
	// Contrast borders
	"--vscode-contrastBorder": "transparent",
	"--vscode-contrastActiveBorder": "transparent",
	// Charts (Codex uses these)
	"--vscode-charts-blue": "#3794ff",
	"--vscode-charts-green": "#89d185",
	"--vscode-charts-orange": "#d18616",
	"--vscode-charts-purple": "#b180d7",
	"--vscode-charts-red": "#f14c4c",
	"--vscode-charts-yellow": "#cca700",
	"--vscode-charts-foreground": "#cccccc",
	"--vscode-charts-lines": "#cccccc80",
	// Chat (Codex/Claude chat UI)
	"--vscode-chat-avatarBackground": "#1f1f1f",
	"--vscode-chat-avatarForeground": "#cccccc",
	"--vscode-chat-requestBackground": "#ffffff0a",
	"--vscode-chat-requestBorder": "#ffffff12",
	"--vscode-chat-slashCommandBackground": "#34414b",
	"--vscode-chat-slashCommandForeground": "#40a6ff",
	"--vscode-chat-editedFileForeground": "#e2c08d",
	// Symbol icons (37 common ones)
	"--vscode-symbolIcon-arrayForeground": "#cccccc",
	"--vscode-symbolIcon-booleanForeground": "#cccccc",
	"--vscode-symbolIcon-classForeground": "#ee9d28",
	"--vscode-symbolIcon-colorForeground": "#cccccc",
	"--vscode-symbolIcon-constantForeground": "#cccccc",
	"--vscode-symbolIcon-constructorForeground": "#b180d7",
	"--vscode-symbolIcon-enumeratorForeground": "#ee9d28",
	"--vscode-symbolIcon-enumeratorMemberForeground": "#75beff",
	"--vscode-symbolIcon-eventForeground": "#ee9d28",
	"--vscode-symbolIcon-fieldForeground": "#75beff",
	"--vscode-symbolIcon-fileForeground": "#cccccc",
	"--vscode-symbolIcon-folderForeground": "#cccccc",
	"--vscode-symbolIcon-functionForeground": "#b180d7",
	"--vscode-symbolIcon-interfaceForeground": "#75beff",
	"--vscode-symbolIcon-keyForeground": "#cccccc",
	"--vscode-symbolIcon-keywordForeground": "#cccccc",
	"--vscode-symbolIcon-methodForeground": "#b180d7",
	"--vscode-symbolIcon-moduleForeground": "#cccccc",
	"--vscode-symbolIcon-namespaceForeground": "#cccccc",
	"--vscode-symbolIcon-numberForeground": "#cccccc",
	"--vscode-symbolIcon-objectForeground": "#cccccc",
	"--vscode-symbolIcon-operatorForeground": "#cccccc",
	"--vscode-symbolIcon-packageForeground": "#cccccc",
	"--vscode-symbolIcon-propertyForeground": "#cccccc",
	"--vscode-symbolIcon-referenceForeground": "#cccccc",
	"--vscode-symbolIcon-snippetForeground": "#cccccc",
	"--vscode-symbolIcon-stringForeground": "#cccccc",
	"--vscode-symbolIcon-structForeground": "#cccccc",
	"--vscode-symbolIcon-textForeground": "#cccccc",
	"--vscode-symbolIcon-typeParameterForeground": "#cccccc",
	"--vscode-symbolIcon-unitForeground": "#cccccc",
	"--vscode-symbolIcon-variableForeground": "#75beff",
	// Chat font
	"--vscode-chat-font-size": "13px",
	"--vscode-chat-editor-font-size": "12px",
};

/**
 * VS Code Light+ default values for light theme.
 */
const VSCODE_LIGHT_DEFAULTS: Record<string, string> = {
	"--vscode-editor-selectionBackground": "#add6ff",
	"--vscode-editor-selectionForeground": "#000000",
	"--vscode-editor-inactiveSelectionBackground": "#e5ebf1",
	"--vscode-editor-selectionHighlightBackground": "#add6ff80",
	"--vscode-editor-findMatchBackground": "#a8ac94",
	"--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
	"--vscode-editor-findRangeHighlightBackground": "#b4b4b44d",
	"--vscode-editor-hoverHighlightBackground": "#add6ff26",
	"--vscode-editor-lineHighlightBackground": "#00000008",
	"--vscode-editor-lineHighlightBorder": "#eeeeee",
	"--vscode-editor-rangeHighlightBackground": "#fdff0033",
	"--vscode-editor-wordHighlightBackground": "#57575740",
	"--vscode-editor-wordHighlightStrongBackground": "#0e639c40",
	"--vscode-editorCursor-foreground": "#000000",
	"--vscode-editorLineNumber-foreground": "#237893",
	"--vscode-editorLineNumber-activeForeground": "#0b216f",
	"--vscode-editorIndentGuide-background": "#d3d3d3",
	"--vscode-editorIndentGuide-activeBackground": "#939393",
	"--vscode-editorWhitespace-foreground": "#33333333",
	"--vscode-editorRuler-foreground": "#d3d3d3",
	"--vscode-editorBracketMatch-background": "#0064001a",
	"--vscode-editorBracketMatch-border": "#b9b9b9",
	"--vscode-editorGutter-addedBackground": "#2ea04350",
	"--vscode-editorGutter-modifiedBackground": "#1b81a850",
	"--vscode-editorGutter-deletedBackground": "#f8514950",
	"--vscode-editorWidget-background": "#f3f3f3",
	"--vscode-editorWidget-foreground": "#616161",
	"--vscode-editorWidget-border": "#c8c8c8",
	"--vscode-editorSuggestWidget-background": "#f3f3f3",
	"--vscode-editorSuggestWidget-foreground": "#000000",
	"--vscode-editorSuggestWidget-selectedBackground": "#d6ebff",
	"--vscode-editorSuggestWidget-highlightForeground": "#0066bf",
	"--vscode-editorHoverWidget-background": "#f3f3f3",
	"--vscode-editorHoverWidget-foreground": "#616161",
	"--vscode-editorHoverWidget-border": "#c8c8c8",
	"--vscode-diffEditor-insertedTextBackground": "#9ccc2c33",
	"--vscode-diffEditor-removedTextBackground": "#ff000033",
	"--vscode-diffEditor-insertedLineBackground": "#9ccc2c20",
	"--vscode-diffEditor-removedLineBackground": "#ff000020",
	"--vscode-diffEditorGutter-insertedLineBackground": "#2ea04350",
	"--vscode-diffEditorGutter-removedLineBackground": "#f8514950",
	"--vscode-diffEditorOverview-insertedForeground": "#2ea04380",
	"--vscode-diffEditorOverview-removedForeground": "#f8514980",
	"--vscode-editorError-foreground": "#e51400",
	"--vscode-editorWarning-foreground": "#bf8803",
	"--vscode-editorInfo-foreground": "#1a85ff",
	"--vscode-editorHint-foreground": "#6c6c6c",
	"--vscode-peekView-border": "#1b81a8",
	"--vscode-peekViewEditor-background": "#f2f8fc",
	"--vscode-peekViewResult-background": "#f3f3f3",
	"--vscode-peekViewTitle-background": "#ffffff",
	"--vscode-peekViewTitleLabel-foreground": "#333333",
	"--vscode-banner-background": "#004386",
	"--vscode-banner-foreground": "#ffffff",
	"--vscode-banner-iconForeground": "#1a85ff",
	"--vscode-contrastBorder": "transparent",
	"--vscode-contrastActiveBorder": "transparent",
	"--vscode-charts-blue": "#1a85ff",
	"--vscode-charts-green": "#388a34",
	"--vscode-charts-orange": "#d18616",
	"--vscode-charts-purple": "#652d90",
	"--vscode-charts-red": "#e51400",
	"--vscode-charts-yellow": "#bf8803",
	"--vscode-charts-foreground": "#616161",
	"--vscode-charts-lines": "#61616180",
	"--vscode-chat-avatarBackground": "#f2f2f2",
	"--vscode-chat-avatarForeground": "#616161",
	"--vscode-chat-requestBackground": "#00000008",
	"--vscode-chat-requestBorder": "#00000012",
	"--vscode-chat-slashCommandBackground": "#d2ecff",
	"--vscode-chat-slashCommandForeground": "#306ca2",
	"--vscode-chat-editedFileForeground": "#895503",
	"--vscode-symbolIcon-arrayForeground": "#616161",
	"--vscode-symbolIcon-booleanForeground": "#616161",
	"--vscode-symbolIcon-classForeground": "#d67e00",
	"--vscode-symbolIcon-constantForeground": "#616161",
	"--vscode-symbolIcon-constructorForeground": "#652d90",
	"--vscode-symbolIcon-enumeratorForeground": "#d67e00",
	"--vscode-symbolIcon-enumeratorMemberForeground": "#007acc",
	"--vscode-symbolIcon-eventForeground": "#d67e00",
	"--vscode-symbolIcon-fieldForeground": "#007acc",
	"--vscode-symbolIcon-fileForeground": "#616161",
	"--vscode-symbolIcon-folderForeground": "#616161",
	"--vscode-symbolIcon-functionForeground": "#652d90",
	"--vscode-symbolIcon-interfaceForeground": "#007acc",
	"--vscode-symbolIcon-keyForeground": "#616161",
	"--vscode-symbolIcon-keywordForeground": "#616161",
	"--vscode-symbolIcon-methodForeground": "#652d90",
	"--vscode-symbolIcon-moduleForeground": "#616161",
	"--vscode-symbolIcon-namespaceForeground": "#616161",
	"--vscode-symbolIcon-numberForeground": "#616161",
	"--vscode-symbolIcon-objectForeground": "#616161",
	"--vscode-symbolIcon-operatorForeground": "#616161",
	"--vscode-symbolIcon-packageForeground": "#616161",
	"--vscode-symbolIcon-propertyForeground": "#616161",
	"--vscode-symbolIcon-referenceForeground": "#616161",
	"--vscode-symbolIcon-snippetForeground": "#616161",
	"--vscode-symbolIcon-stringForeground": "#616161",
	"--vscode-symbolIcon-structForeground": "#616161",
	"--vscode-symbolIcon-textForeground": "#616161",
	"--vscode-symbolIcon-typeParameterForeground": "#616161",
	"--vscode-symbolIcon-unitForeground": "#616161",
	"--vscode-symbolIcon-variableForeground": "#007acc",
	"--vscode-chat-font-size": "13px",
	"--vscode-chat-editor-font-size": "12px",
};

/**
 * Returns the VS Code body class based on current theme.
 */
export function getVscodeBodyClass(): string {
	const isDark = document.documentElement.classList.contains("dark");
	return isDark ? "vscode-dark" : "vscode-light";
}
