import { EditorView } from "@codemirror/view";

export const conflictTheme = EditorView.baseTheme({
	// Current (HEAD) — VSCode風の薄い緑
	".cm-conflict-current": {
		backgroundColor: "rgba(35, 134, 54, 0.12)",
	},
	// Incoming — VSCode風の薄い青
	".cm-conflict-incoming": {
		backgroundColor: "rgba(17, 119, 187, 0.12)",
	},
	// ======= セパレータ — ほぼ透明
	".cm-conflict-separator": {
		backgroundColor: "rgba(128, 128, 128, 0.08)",
	},
	// <<<<<<< / >>>>>>> マーカー行
	".cm-conflict-marker": {
		backgroundColor: "rgba(128, 128, 128, 0.12)",
		color: "var(--muted-foreground)",
		fontStyle: "italic",
	},
	// Accept アクション行
	".cm-conflict-action-widget": {
		display: "block",
		fontSize: "0.75em",
		lineHeight: "1.8",
		userSelect: "none",
		padding: "0 0.75em",
		color: "var(--muted-foreground)",
		borderTop: "1px solid var(--border)",
	},
	".cm-conflict-action-btn": {
		display: "inline-block",
		cursor: "pointer",
		padding: "0 0.25em",
		color: "var(--muted-foreground)",
		transition: "color 0.1s",
		"&:hover": {
			color: "var(--foreground)",
			textDecoration: "underline",
		},
	},
	".cm-conflict-action-btn-current": {
		"&:hover": {
			color: "rgb(35, 197, 94)",
		},
	},
	".cm-conflict-action-btn-incoming": {
		"&:hover": {
			color: "rgb(56, 154, 230)",
		},
	},
	".cm-conflict-action-separator": {
		display: "inline-block",
		padding: "0 0.25em",
		opacity: "0.3",
	},
});
