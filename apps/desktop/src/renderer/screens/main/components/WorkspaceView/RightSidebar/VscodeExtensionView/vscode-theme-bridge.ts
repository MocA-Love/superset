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
			const needsWrap = /^\d/.test(value) && !value.includes("(");
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

	lines.push("}");

	// Dark/light body class for extensions that check it
	lines.push(`body { color-scheme: ${isDark ? "dark" : "light"}; }`);
	lines.push(`body.vscode-dark, body.vscode-light { margin: 0; padding: 0; }`);

	return lines.join("\n");
}

/**
 * Returns the VS Code body class based on current theme.
 */
export function getVscodeBodyClass(): string {
	const isDark = document.documentElement.classList.contains("dark");
	return isDark ? "vscode-dark" : "vscode-light";
}
