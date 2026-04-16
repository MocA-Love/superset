import type { UIColors } from "shared/themes/types";

/**
 * Maps UI color keys to CSS variable names
 */
const UI_COLOR_TO_CSS_VAR: Record<keyof UIColors, string> = {
	background: "--background",
	foreground: "--foreground",
	card: "--card",
	cardForeground: "--card-foreground",
	popover: "--popover",
	popoverForeground: "--popover-foreground",
	primary: "--primary",
	primaryForeground: "--primary-foreground",
	secondary: "--secondary",
	secondaryForeground: "--secondary-foreground",
	muted: "--muted",
	mutedForeground: "--muted-foreground",
	accent: "--accent",
	accentForeground: "--accent-foreground",
	tertiary: "--tertiary",
	tertiaryActive: "--tertiary-active",
	destructive: "--destructive",
	destructiveForeground: "--destructive-foreground",
	border: "--border",
	input: "--input",
	ring: "--ring",
	sidebar: "--sidebar",
	sidebarForeground: "--sidebar-foreground",
	sidebarPrimary: "--sidebar-primary",
	sidebarPrimaryForeground: "--sidebar-primary-foreground",
	sidebarAccent: "--sidebar-accent",
	sidebarAccentForeground: "--sidebar-accent-foreground",
	sidebarBorder: "--sidebar-border",
	sidebarRing: "--sidebar-ring",
	chart1: "--chart-1",
	chart2: "--chart-2",
	chart3: "--chart-3",
	chart4: "--chart-4",
	chart5: "--chart-5",
	highlightMatch: "--highlight-match",
	highlightActive: "--highlight-active",
};

/**
 * Apply UI colors to CSS variables on :root
 */
export function applyUIColors(colors: UIColors): void {
	const root = document.documentElement;

	for (const [key, cssVar] of Object.entries(UI_COLOR_TO_CSS_VAR)) {
		const value = colors[key as keyof UIColors];
		if (value) {
			root.style.setProperty(cssVar, value);
		}
	}

	// `--background-solid` always mirrors the theme's opaque background so
	// non-surface consumers (text color, ring color, SVG fill, gradients)
	// can reference a reliably opaque value even when vibrancy forces
	// `--background` to `transparent` for pass-through surfaces.
	if (colors.background) {
		root.style.setProperty("--background-solid", colors.background);
	}
}

/**
 * Update dark/light mode class based on theme type
 */
export function updateThemeClass(type: "dark" | "light"): void {
	const html = document.documentElement;
	if (type === "dark") {
		html.classList.add("dark");
		html.classList.remove("light");
	} else {
		html.classList.add("light");
		html.classList.remove("dark");
	}
}

/**
 * Remove all theme CSS variables (reset to stylesheet defaults)
 */
export function clearThemeVariables(): void {
	const root = document.documentElement;
	for (const cssVar of Object.values(UI_COLOR_TO_CSS_VAR)) {
		root.style.removeProperty(cssVar);
	}
	// Sibling of `--background` that `applyUIColors` mirrors — reset it
	// here too or a stale opaque color lingers after vibrancy toggles.
	root.style.removeProperty("--background-solid");
}
