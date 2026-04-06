import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

const DEFAULT_COLOR = "rgba(255, 0, 0, 0.3)";

function buildTrailingSpacesTheme(color: string): Extension {
	return EditorView.theme({
		".cm-trailing-space": {
			backgroundColor: color,
			borderRadius: "1px",
		},
	});
}

function buildDecorations(view: EditorView): DecorationSet {
	const doc = view.state.doc;
	const cursorLine = doc.lineAt(view.state.selection.main.head).number;
	const decorations: Array<{ from: number; to: number }> = [];

	for (const { from, to } of view.visibleRanges) {
		const startLine = doc.lineAt(from).number;
		const endLine = doc.lineAt(to).number;

		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			// Skip the line the cursor is on
			if (lineNum === cursorLine) continue;

			const line = doc.line(lineNum);
			const text = line.text;
			if (text.length === 0) continue;

			// Find trailing whitespace
			let trailStart = text.length;
			while (
				trailStart > 0 &&
				(text[trailStart - 1] === " " || text[trailStart - 1] === "\t")
			) {
				trailStart--;
			}

			if (trailStart < text.length) {
				decorations.push({
					from: line.from + trailStart,
					to: line.to,
				});
			}
		}
	}

	if (decorations.length === 0) return Decoration.none;

	return Decoration.set(
		decorations.map((d) =>
			Decoration.mark({ class: "cm-trailing-space" }).range(d.from, d.to),
		),
	);
}

export function createTrailingSpacesPlugin(color?: string | null): Extension {
	const resolvedColor = color || DEFAULT_COLOR;

	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet
				) {
					this.decorations = buildDecorations(update.view);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);

	return [plugin, buildTrailingSpacesTheme(resolvedColor)];
}

export { DEFAULT_COLOR as TRAILING_SPACES_DEFAULT_COLOR };
