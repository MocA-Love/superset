import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { getChunks, MergeView } from "@codemirror/merge";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { createCodeMirrorTheme } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createCodeMirrorTheme";
import { loadLanguageSupport } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/loadLanguageSupport";
import { getCodeSyntaxHighlighting } from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { useResolvedTheme } from "renderer/stores/theme";
import type { DiffViewMode } from "shared/changes-types";

// Line decoration that suppresses inline cm-changedText highlights
const suppressLineDeco = Decoration.line({ class: "cm-suppress-inline-diff" });

/**
 * Build a ViewPlugin that suppresses inline diff highlights on pure-insertion
 * (side="b") or pure-deletion (side="a") lines, matching VSCode behavior.
 * isPureChange(change) should return true when the change has no counterpart
 * on the opposite side.
 */
function makeSuppressPlugin(
	side: "a" | "b",
	isPureChange: (change: { fromA: number; toA: number; fromB: number; toB: number }) => boolean,
	absFrom: (chunk: { fromA: number; fromB: number }, change: { fromA: number; fromB: number }) => number,
	absTo: (chunk: { fromA: number; fromB: number }, change: { toA: number; toB: number }) => number,
) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.buildDecorations(update.view);
				}
			}

			buildDecorations(view: EditorView): DecorationSet {
				const result = getChunks(view.state);
				if (!result) return Decoration.none;

				const doc = view.state.doc;
				const lineFroms = new Set<number>();

				for (const chunk of result.chunks) {
					for (const change of chunk.changes) {
						if (!isPureChange(change)) continue;

						const from = absFrom(chunk, change);
						const to = absTo(chunk, change);
						if (from >= to) continue;

						let pos = from;
						while (pos < to) {
							const line = doc.lineAt(pos);
							lineFroms.add(line.from);
							pos = line.to + 1;
						}
					}
				}

				if (lineFroms.size === 0) return Decoration.none;

				const sorted = [...lineFroms].sort((a, b) => a - b);
				return Decoration.set(sorted.map((from) => suppressLineDeco.range(from)));
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

// b side: suppress pure insertions (no A counterpart)
const suppressInsertions = makeSuppressPlugin(
	"b",
	(change) => change.fromA === change.toA,
	(chunk, change) => chunk.fromB + change.fromB,
	(chunk, change) => chunk.fromB + change.toB,
);

// a side: suppress pure deletions (no B counterpart)
const suppressDeletions = makeSuppressPlugin(
	"a",
	(change) => change.fromB === change.toB,
	(chunk, change) => chunk.fromA + change.fromA,
	(chunk, change) => chunk.fromA + change.toA,
);

interface CodeMirrorDiffViewerProps {
	original: string;
	modified: string;
	language: string;
	viewMode: DiffViewMode;
	onChange?: (value: string) => void;
	onSave?: () => void;
}

export function CodeMirrorDiffViewer({
	original,
	modified,
	language,
	viewMode,
	onChange,
	onSave,
}: CodeMirrorDiffViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mergeViewRef = useRef<MergeView | null>(null);
	const langCompartmentA = useRef(new Compartment()).current;
	const langCompartmentB = useRef(new Compartment()).current;
	const themeCompartmentA = useRef(new Compartment()).current;
	const themeCompartmentB = useRef(new Compartment()).current;
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const activeTheme = useResolvedTheme();
	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{ staleTime: 30_000 },
	);
	const editorFontFamily = fontSettings?.editorFontFamily ?? undefined;
	const editorFontSize = fontSettings?.editorFontSize ?? undefined;

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: MergeView is created once and destroyed on unmount
	useEffect(() => {
		if (!containerRef.current) return;

		const readOnlyExtensions = [
			lineNumbers(),
			highlightSpecialChars(),
			drawSelection(),
			highlightSelectionMatches(),
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			EditorView.lineWrapping,
			keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap]),
			suppressDeletions,
		];

		const editableExtensions = [
			lineNumbers(),
			highlightSpecialChars(),
			drawSelection(),
			highlightSelectionMatches(),
			EditorView.lineWrapping,
			keymap.of([
				indentWithTab,
				...defaultKeymap,
				...searchKeymap,
				{
					key: "Mod-s",
					run: () => {
						onSaveRef.current?.();
						return true;
					},
				},
			]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChangeRef.current?.(update.state.doc.toString());
				}
			}),
			suppressInsertions,
		];

		const themeExts = [
			getCodeSyntaxHighlighting(activeTheme),
			createCodeMirrorTheme(
				activeTheme,
				{ fontFamily: editorFontFamily, fontSize: editorFontSize },
				true,
			),
		];

		const mergeView = new MergeView({
			parent: containerRef.current,
			collapseUnchanged: { margin: 3, minSize: 4 },
			diffConfig: { scanLimit: 50000, timeout: 5000 },
			revertControls: "a-to-b",
			a: {
				doc: original,
				extensions: [
					...readOnlyExtensions,
					themeCompartmentA.of(themeExts),
					langCompartmentA.of([]),
				],
			},
			b: {
				doc: modified,
				extensions: [
					...editableExtensions,
					themeCompartmentB.of(themeExts),
					langCompartmentB.of([]),
				],
			},
		});

		mergeViewRef.current = mergeView;

		void loadLanguageSupport(language).then((ext) => {
			if (!ext || !mergeViewRef.current) return;
			const mv = mergeViewRef.current;
			mv.a.dispatch({ effects: langCompartmentA.reconfigure(ext) });
			mv.b.dispatch({ effects: langCompartmentB.reconfigure(ext) });
		});

		return () => {
			mergeView.destroy();
			mergeViewRef.current = null;
		};
	}, [original, modified, language, viewMode]);

	useEffect(() => {
		const mv = mergeViewRef.current;
		if (!mv) return;

		const themeExts = [
			getCodeSyntaxHighlighting(activeTheme),
			createCodeMirrorTheme(
				activeTheme,
				{ fontFamily: editorFontFamily, fontSize: editorFontSize },
				true,
			),
		];

		mv.a.dispatch({ effects: themeCompartmentA.reconfigure(themeExts) });
		mv.b.dispatch({ effects: themeCompartmentB.reconfigure(themeExts) });
	}, [
		activeTheme,
		editorFontFamily,
		editorFontSize,
		themeCompartmentA,
		themeCompartmentB,
	]);

	return <div ref={containerRef} className="h-full w-full overflow-auto" />;
}
