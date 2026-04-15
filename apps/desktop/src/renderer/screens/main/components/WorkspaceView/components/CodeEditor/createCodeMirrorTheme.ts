import { EditorView } from "@codemirror/view";
import { getEditorTheme, type Theme } from "shared/themes";
import {
	DEFAULT_CODE_EDITOR_FONT_FAMILY,
	DEFAULT_CODE_EDITOR_FONT_SIZE,
} from "./constants";

interface CodeEditorFontSettings {
	fontFamily?: string;
	fontSize?: number;
}

interface CodeEditorThemeOptions {
	/**
	 * If set (0-1), the editor background is mixed with `transparent` at this
	 * alpha so the window's vibrancy layer can show through. Leave undefined
	 * for the default opaque rendering.
	 */
	vibrancyOpacity?: number;
}

function toTranslucentBackground(base: string, alpha: number): string {
	const clamped = Math.max(0, Math.min(1, alpha));
	return `color-mix(in srgb, ${base} ${(clamped * 100).toFixed(2)}%, transparent)`;
}

export function createCodeMirrorTheme(
	theme: Theme,
	fontSettings: CodeEditorFontSettings,
	fillHeight: boolean,
	options: CodeEditorThemeOptions = {},
) {
	const fontSize = fontSettings.fontSize ?? DEFAULT_CODE_EDITOR_FONT_SIZE;
	const lineHeight = Math.round(fontSize * 1.5);
	const editorTheme = getEditorTheme(theme);
	const backgroundColor =
		options.vibrancyOpacity !== undefined
			? toTranslucentBackground(
					editorTheme.colors.background,
					options.vibrancyOpacity,
				)
			: editorTheme.colors.background;
	const gutterBackground =
		options.vibrancyOpacity !== undefined
			? toTranslucentBackground(
					editorTheme.colors.gutterBackground,
					options.vibrancyOpacity,
				)
			: editorTheme.colors.gutterBackground;

	return EditorView.theme(
		{
			"&": {
				height: fillHeight ? "100%" : "auto",
				backgroundColor,
				color: editorTheme.colors.foreground,
				fontFamily: fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY,
				fontSize: `${fontSize}px`,
			},
			".cm-scroller": {
				fontFamily: "inherit",
				lineHeight: `${lineHeight}px`,
				overflow: fillHeight ? "auto" : "visible",
			},
			".cm-content": {
				padding: "8px 0",
				caretColor: editorTheme.colors.cursor,
			},
			".cm-line": {
				padding: "0 12px",
			},
			".cm-gutters": {
				backgroundColor: gutterBackground,
				color: editorTheme.colors.gutterForeground,
				borderRight: `1px solid ${editorTheme.colors.border}`,
			},
			".cm-activeLine": {
				backgroundColor: editorTheme.colors.activeLine,
			},
			".cm-activeLineGutter": {
				backgroundColor: editorTheme.colors.activeLine,
			},
			".cm-line.cm-jump-highlight, .cm-line.cm-jump-highlight.cm-activeLine": {
				backgroundColor: `${editorTheme.colors.searchActive}55`,
				boxShadow: `inset 3px 0 0 ${editorTheme.colors.searchActive}, inset 0 0 0 9999px ${editorTheme.colors.searchActive}22`,
				transition: "background-color 1.2s ease-out, box-shadow 1.2s ease-out",
			},
			"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
				{
					backgroundColor: editorTheme.colors.selection,
				},
			".cm-selectionMatch": {
				backgroundColor: editorTheme.colors.search,
			},
			".cm-cursor, .cm-dropCursor": {
				borderLeftColor: editorTheme.colors.cursor,
			},
			".cm-searchMatch": {
				backgroundColor: editorTheme.colors.search,
				outline: "none",
			},
			".cm-searchMatch.cm-searchMatch-selected": {
				backgroundColor: editorTheme.colors.searchActive,
			},
			".cm-panels": {
				backgroundColor: editorTheme.colors.panel,
				color: editorTheme.colors.foreground,
				borderBottom: `1px solid ${editorTheme.colors.panelBorder}`,
			},
			".cm-panels .cm-textfield": {
				backgroundColor: editorTheme.colors.panelInputBackground,
				color: editorTheme.colors.panelInputForeground,
				border: `1px solid ${editorTheme.colors.panelInputBorder}`,
			},
			".cm-button": {
				backgroundImage: "none",
				backgroundColor: editorTheme.colors.panelButtonBackground,
				color: editorTheme.colors.panelButtonForeground,
				border: `1px solid ${editorTheme.colors.panelButtonBorder}`,
			},
			".cm-tooltip.cm-tooltip-hover": {
				border: `1px solid ${editorTheme.colors.panelBorder}`,
				backgroundColor: editorTheme.colors.panel,
				color: editorTheme.colors.foreground,
				borderRadius: "10px",
				boxShadow:
					"0 16px 40px rgba(0, 0, 0, 0.28), 0 4px 14px rgba(0, 0, 0, 0.16)",
				overflow: "hidden",
			},
			".cm-tooltip.cm-tooltip-hover .cm-tooltip-arrow:before": {
				borderTopColor: editorTheme.colors.panel,
				borderBottomColor: editorTheme.colors.panel,
			},
			".cm-tooltip.cm-tooltip-hover .cm-tooltip-arrow:after": {
				borderTopColor: editorTheme.colors.panelBorder,
				borderBottomColor: editorTheme.colors.panelBorder,
			},
			".cm-definition-link": {
				cursor: "pointer",
				textDecoration: `underline ${editorTheme.colors.searchActive}`,
				textUnderlineOffset: "2px",
				textDecorationThickness: "1px",
			},
			"&.cm-definition-link-mode .cm-content": {
				cursor: "pointer",
			},
			".cm-superset-symbol-hover": {
				width: "min(560px, 70vw)",
				maxHeight: "min(420px, 60vh)",
				display: "flex",
				flexDirection: "column",
				backgroundColor: editorTheme.colors.panel,
				color: editorTheme.colors.foreground,
			},
			".cm-superset-symbol-hover-body": {
				overflow: "auto",
			},
			".cm-superset-symbol-hover-section": {
				padding: "10px 12px",
				fontSize: "12px",
				lineHeight: "1.6",
			},
			".cm-superset-symbol-hover-section-bordered": {
				borderTop: `1px solid ${editorTheme.colors.border}`,
			},
			".cm-superset-symbol-hover-plaintext": {
				margin: "0",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontFamily: fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY,
				fontSize: "12px",
				lineHeight: "1.55",
			},
			".cm-superset-symbol-hover-paragraph": {
				margin: "0 0 8px 0",
			},
			".cm-superset-symbol-hover-paragraph:last-child": {
				marginBottom: "0",
			},
			".cm-superset-symbol-hover-inline-code": {
				padding: "1px 5px",
				borderRadius: "5px",
				backgroundColor: editorTheme.colors.activeLine,
				fontFamily: fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY,
				fontSize: "11px",
			},
			".cm-superset-symbol-hover-link": {
				color: editorTheme.colors.searchActive,
				textDecoration: "underline",
			},
			".cm-superset-symbol-hover-list": {
				margin: "8px 0 0 0",
				paddingLeft: "18px",
			},
			".cm-superset-symbol-hover-list-ordered": {
				listStyleType: "decimal",
			},
			".cm-superset-symbol-hover-list-item": {
				marginBottom: "4px",
			},
			".cm-superset-symbol-hover-blockquote": {
				margin: "8px 0 0 0",
				paddingLeft: "10px",
				borderLeft: `2px solid ${editorTheme.colors.border}`,
				color: editorTheme.colors.gutterForeground,
			},
			".cm-superset-symbol-hover-heading": {
				margin: "0 0 8px 0",
				fontSize: "12px",
				fontWeight: "600",
			},
			".cm-superset-symbol-hover-table-wrap": {
				overflowX: "auto",
				marginTop: "8px",
			},
			".cm-superset-symbol-hover-table": {
				borderCollapse: "collapse",
				width: "100%",
			},
			".cm-superset-symbol-hover-table th, .cm-superset-symbol-hover-table td":
				{
					border: `1px solid ${editorTheme.colors.border}`,
					padding: "4px 6px",
					textAlign: "left",
				},
			".cm-superset-symbol-hover-code-block": {
				margin: "8px 0 0 0",
				borderRadius: "8px",
				border: `1px solid ${editorTheme.colors.border}`,
				backgroundColor: editorTheme.colors.background,
				overflow: "auto",
			},
			".cm-superset-symbol-hover-code-block pre": {
				margin: "0",
			},
			".cm-superset-symbol-hover-code-block code": {
				display: "block",
				padding: "10px 12px",
				fontFamily: fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY,
				fontSize: "12px",
				lineHeight: "1.55",
				whiteSpace: "pre",
			},
			".cm-superset-symbol-hover .shiki": {
				margin: "0",
				padding: "0",
				backgroundColor: "transparent !important",
				fontSize: "12px",
				lineHeight: "1.55",
			},
			".cm-superset-symbol-hover .shiki code": {
				padding: "10px 0",
				fontFamily: fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY,
			},
			".cm-superset-symbol-hover .shiki code .line": {
				display: "block",
				padding: "0 12px",
			},
			".cm-superset-symbol-hover-footer": {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				padding: "8px 12px",
				borderTop: `1px solid ${editorTheme.colors.border}`,
				backgroundColor: editorTheme.colors.activeLine,
			},
			".cm-superset-symbol-hover-action": {
				padding: "0",
				border: "0",
				background: "transparent",
				color: editorTheme.colors.searchActive,
				fontSize: "11px",
				fontWeight: "600",
				cursor: "pointer",
			},
			".cm-superset-symbol-hover-shortcut": {
				fontSize: "11px",
				color: editorTheme.colors.gutterForeground,
			},
			// Diff / merge view colors (a = original/left, b = modified/right)
			"&.cm-merge-a .cm-changedLine": {
				backgroundColor: `${editorTheme.colors.deletion}14`,
			},
			"&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine": {
				backgroundColor: `${editorTheme.colors.addition}14`,
			},
			".cm-deletedChunk": {
				backgroundColor: `${editorTheme.colors.deletion}14`,
			},
			"&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
				background: `${editorTheme.colors.deletion}2a !important`,
			},
			"&.cm-merge-b .cm-changedText": {
				background: `${editorTheme.colors.addition}2a !important`,
			},
			"&.cm-merge-b .cm-deletedText": {
				background: `${editorTheme.colors.deletion}14 !important`,
			},
			// Empty space on opposite side of insertion/deletion: diagonal stripe pattern
			".cm-mergeSpacer": {
				backgroundImage: `repeating-linear-gradient(
					-45deg,
					${editorTheme.colors.border}b3 0px,
					${editorTheme.colors.border}b3 1px,
					transparent 1px,
					transparent 6px
				)`,
				backgroundSize: "8px 8px",
			},
			// Pure insertion/deletion lines: suppress inline highlight (only show line background)
			// cm-suppress-inline-diff is a line decoration on the .cm-line element
			// cm-changedText = b side inline highlight, cm-deletedText = a side deleted content
			".cm-suppress-inline-diff .cm-changedText, .cm-suppress-inline-diff .cm-deletedText":
				{
					background: "transparent !important",
				},
		},
		{
			dark: theme.type === "dark",
		},
	);
}
