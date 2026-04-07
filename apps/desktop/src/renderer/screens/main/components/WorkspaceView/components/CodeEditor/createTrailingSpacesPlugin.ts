import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

const DEFAULT_COLOR = "#ff00004d";

/** Check if a character is any kind of whitespace (including full-width, NBSP, etc.) */
function isWhitespace(ch: string): boolean {
	const code = ch.charCodeAt(0);
	// Common ASCII whitespace
	if (code === 0x20 || code === 0x09) return true; // space, tab
	// Unicode whitespace
	if (code === 0x3000) return true; // full-width space (　)
	if (code === 0x00a0) return true; // non-breaking space
	if (code === 0x2000 || code === 0x2001 || code === 0x2002 || code === 0x2003)
		return true; // en/em spaces
	if (code === 0x2004 || code === 0x2005 || code === 0x2006 || code === 0x2007)
		return true; // various spaces
	if (code === 0x2008 || code === 0x2009 || code === 0x200a) return true; // punctuation/thin/hair space
	if (code === 0x200b) return true; // zero-width space
	if (code === 0x202f) return true; // narrow no-break space
	if (code === 0x205f) return true; // medium mathematical space
	if (code === 0xfeff) return true; // BOM / zero-width no-break space
	return false;
}

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

			// Find trailing whitespace (including full-width spaces, NBSP, etc.)
			let trailStart = text.length;
			while (trailStart > 0 && isWhitespace(text[trailStart - 1])) {
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
