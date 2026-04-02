import { registerCustomTheme } from "@pierre/diffs";
import type { DiffsThemeNames } from "@pierre/diffs/react";
import { getEditorTheme, type Theme } from "shared/themes";
import { createShikiTheme } from "./shiki-theme";

const REGISTERED_DIFF_THEMES = new Set<string>();

function hashString(value: string): string {
	let hash = 0;

	for (let index = 0; index < value.length; index += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(index);
		hash |= 0;
	}

	return Math.abs(hash).toString(36);
}

function createDiffThemeName(theme: Theme): DiffsThemeNames {
	const signature = hashString(JSON.stringify(getEditorTheme(theme)));
	return `superset-diff-${theme.id}-${signature}` as DiffsThemeNames;
}

export function getDiffsTheme(theme: Theme): DiffsThemeNames {
	const themeName = createDiffThemeName(theme);

	if (!REGISTERED_DIFF_THEMES.has(themeName)) {
		registerCustomTheme(themeName, async () => ({
			...createShikiTheme(theme),
			name: createDiffThemeName(theme),
		}));
		REGISTERED_DIFF_THEMES.add(themeName);
	}

	return themeName;
}
