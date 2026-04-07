import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

const DEFAULT_COLORS = [
	"#03045e26",
	"#023e8a26",
	"#0077b626",
	"#0096c726",
	"#00b4d826",
	"#48cae426",
	"#90e0ef26",
	"#90e0ef1a",
	"#90e0ef0d",
	"#90e0ef06",
];

function buildIndentRainbowTheme(colors: string[]): Extension {
	const rules: Record<string, { backgroundColor: string }> = {};
	for (let i = 0; i < colors.length; i++) {
		rules[`.cm-indent-rainbow-${i}`] = { backgroundColor: colors[i] };
	}
	return EditorView.theme(rules);
}

function buildDecorations(view: EditorView, colors: string[]): DecorationSet {
	const colorCount = colors.length;
	if (colorCount === 0) return Decoration.none;

	const tabSize = view.state.tabSize;
	const decorations: Array<{ from: number; to: number; colorIndex: number }> =
		[];

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.sliceDoc(from, to);
		const lines = text.split("\n");
		let lineStart = from;

		for (const line of lines) {
			if (line.length > 0) {
				let col = 0;
				let charIdx = 0;

				while (charIdx < line.length) {
					const ch = line[charIdx];
					if (ch === " ") {
						col++;
						charIdx++;
					} else if (ch === "\t") {
						col += tabSize - (col % tabSize);
						charIdx++;
					} else {
						break;
					}
				}

				if (charIdx > 0) {
					// Re-walk to build per-indent-level decorations
					let currentCol = 0;
					let pos = 0;
					let indentLevel = 0;

					while (pos < charIdx) {
						const indentStart = lineStart + pos;
						const targetCol = (indentLevel + 1) * tabSize;
						const ch = line[pos];

						if (ch === "\t") {
							// A tab covers from currentCol to the next tab stop
							const tabEnd = currentCol + tabSize - (currentCol % tabSize);
							decorations.push({
								from: indentStart,
								to: indentStart + 1,
								colorIndex: indentLevel % colorCount,
							});
							currentCol = tabEnd;
							pos++;
							indentLevel = Math.floor(currentCol / tabSize);
						} else {
							// Spaces: collect until we reach the next indent level boundary or run out of whitespace
							const spanStart = pos;
							while (
								pos < charIdx &&
								line[pos] === " " &&
								currentCol < targetCol
							) {
								currentCol++;
								pos++;
							}
							if (pos > spanStart) {
								decorations.push({
									from: lineStart + spanStart,
									to: lineStart + pos,
									colorIndex: indentLevel % colorCount,
								});
							}
							if (currentCol >= targetCol) {
								indentLevel++;
							}
						}
					}
				}
			}

			lineStart += line.length + 1; // +1 for the newline
		}
	}

	if (decorations.length === 0) return Decoration.none;

	// Decorations must be sorted by from position
	decorations.sort((a, b) => a.from - b.from || a.to - b.to);

	return Decoration.set(
		decorations.map((d) =>
			Decoration.mark({ class: `cm-indent-rainbow-${d.colorIndex}` }).range(
				d.from,
				d.to,
			),
		),
	);
}

export function createIndentRainbowPlugin(colors?: string[] | null): Extension {
	const resolvedColors = colors && colors.length > 0 ? colors : DEFAULT_COLORS;

	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, resolvedColors);
			}

			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.geometryChanged
				) {
					this.decorations = buildDecorations(update.view, resolvedColors);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);

	return [plugin, buildIndentRainbowTheme(resolvedColors)];
}

export { DEFAULT_COLORS as INDENT_RAINBOW_DEFAULT_COLORS };
