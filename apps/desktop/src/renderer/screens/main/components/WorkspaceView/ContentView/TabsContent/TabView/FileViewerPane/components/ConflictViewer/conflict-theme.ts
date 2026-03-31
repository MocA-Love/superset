import { EditorView } from "@codemirror/view";

export const conflictTheme = EditorView.baseTheme({
	".cm-conflict-current": {
		backgroundColor: "rgba(40, 167, 69, 0.15)",
	},
	".cm-conflict-incoming": {
		backgroundColor: "rgba(0, 123, 255, 0.15)",
	},
	".cm-conflict-separator": {
		backgroundColor: "rgba(128, 128, 128, 0.15)",
	},
	".cm-conflict-marker": {
		backgroundColor: "rgba(128, 128, 128, 0.25)",
		fontWeight: "bold",
	},
	".cm-conflict-action-widget": {
		display: "block",
		fontSize: "0.8em",
		lineHeight: "1.6",
		userSelect: "none",
		padding: "0 0.5em",
		color: "var(--muted-foreground)",
	},
	".cm-conflict-action-btn": {
		display: "inline-block",
		cursor: "pointer",
		padding: "0 0.3em",
		borderRadius: "3px",
		"&:hover": {
			color: "var(--foreground)",
			textDecoration: "underline",
		},
	},
	".cm-conflict-action-separator": {
		display: "inline-block",
		padding: "0 0.2em",
		opacity: "0.5",
	},
});
