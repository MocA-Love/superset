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
import {
	type BlameEntry,
	createBlamePlugin,
} from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createBlamePlugin";
import { createCodeMirrorTheme } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createCodeMirrorTheme";
import {
	createInlineCompletionPlugin,
	type InlineCompletionRequest,
} from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createInlineCompletionPlugin";
import { loadLanguageSupport } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/loadLanguageSupport";
import { getCodeSyntaxHighlighting } from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { useResolvedTheme } from "renderer/stores/theme";
import type { DiffViewMode } from "shared/changes-types";
import { getEditorTheme } from "shared/themes";

// Line decoration that suppresses inline cm-changedText highlights
const suppressLineDeco = Decoration.line({ class: "cm-suppress-inline-diff" });

/**
 * Build a ViewPlugin that suppresses inline diff highlights on pure-insertion
 * (side="b") or pure-deletion (side="a") lines, matching VSCode behavior.
 * isPureChange(change) should return true when the change has no counterpart
 * on the opposite side.
 */
function makeSuppressPlugin(
	_side: "a" | "b",
	isPureChange: (change: {
		fromA: number;
		toA: number;
		fromB: number;
		toB: number;
	}) => boolean,
	absFrom: (
		chunk: { fromA: number; fromB: number },
		change: { fromA: number; fromB: number },
	) => number,
	absTo: (
		chunk: { fromA: number; fromB: number },
		change: { toA: number; toB: number },
	) => number,
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
				return Decoration.set(
					sorted.map((from) => suppressLineDeco.range(from)),
				);
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
	worktreePath?: string;
	viewMode: DiffViewMode;
	onChange?: (value: string) => void;
	onSave?: () => void;
	blameEntries?: BlameEntry[];
	diagnostics?: Array<{
		line: number | null;
		column: number | null;
		endLine: number | null;
		endColumn: number | null;
		severity: "error" | "warning" | "info" | "hint";
	}>;
	inlineCompletionRequest?: InlineCompletionRequest | null;
}

function createDiagnosticsTheme(theme: ReturnType<typeof getEditorTheme>) {
	return EditorView.theme({
		".cm-problem-underline-error": {
			textDecoration: `underline wavy ${theme.colors.deletion}`,
			textUnderlineOffset: "3px",
			textDecorationThickness: "1.5px",
		},
		".cm-problem-underline-warning": {
			textDecoration: `underline wavy ${theme.colors.modified}`,
			textUnderlineOffset: "3px",
			textDecorationThickness: "1.5px",
		},
		".cm-problem-underline-info, .cm-problem-underline-hint": {
			textDecoration: `underline dotted ${theme.colors.searchActive}`,
			textUnderlineOffset: "3px",
			textDecorationThickness: "1.5px",
		},
	});
}

function buildDiagnosticDecorations(
	doc: EditorState["doc"],
	diagnostics: NonNullable<CodeMirrorDiffViewerProps["diagnostics"]>,
) {
	const decorations = diagnostics
		.filter((diagnostic) => diagnostic.line !== null)
		.map((diagnostic) => {
			const startLine = Math.max(1, Math.min(diagnostic.line ?? 1, doc.lines));
			const startLineInfo = doc.line(startLine);
			const startOffset = Math.max(0, (diagnostic.column ?? 1) - 1);
			const from = Math.min(startLineInfo.from + startOffset, startLineInfo.to);

			const endLineNumber = Math.max(
				startLine,
				Math.min(diagnostic.endLine ?? startLine, doc.lines),
			);
			const endLineInfo = doc.line(endLineNumber);
			const endOffset = Math.max(
				0,
				(diagnostic.endColumn ??
					(diagnostic.column !== null ? diagnostic.column + 1 : 2)) - 1,
			);
			let to = Math.min(endLineInfo.from + endOffset, endLineInfo.to);

			if (to <= from) {
				to = Math.min(from + 1, startLineInfo.to);
			}

			if (to <= from) {
				return null;
			}

			return Decoration.mark({
				class: `cm-problem-underline-${diagnostic.severity}`,
			}).range(from, to);
		})
		.filter((decoration) => decoration !== null);

	return Decoration.set(decorations, true);
}

export function CodeMirrorDiffViewer({
	original,
	modified,
	language,
	worktreePath,
	viewMode,
	onChange,
	onSave,
	blameEntries,
	diagnostics = [],
	inlineCompletionRequest,
}: CodeMirrorDiffViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mergeViewRef = useRef<MergeView | null>(null);
	const langCompartmentA = useRef(new Compartment()).current;
	const langCompartmentB = useRef(new Compartment()).current;
	const themeCompartmentA = useRef(new Compartment()).current;
	const themeCompartmentB = useRef(new Compartment()).current;
	const blameCompartmentB = useRef(new Compartment()).current;
	const diagnosticsCompartmentB = useRef(new Compartment()).current;
	const inlineCompletionCompartmentB = useRef(new Compartment()).current;
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const inlineCompletionRequestRef = useRef(inlineCompletionRequest);
	const activeTheme = useResolvedTheme();
	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{ staleTime: 30_000 },
	);
	const editorFontFamily = fontSettings?.editorFontFamily ?? undefined;
	const editorFontSize = fontSettings?.editorFontSize ?? undefined;
	const editorTheme = getEditorTheme(activeTheme);

	onChangeRef.current = onChange;
	onSaveRef.current = onSave;
	inlineCompletionRequestRef.current = inlineCompletionRequest;

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
			inlineCompletionCompartmentB.of(
				inlineCompletionRequestRef.current
					? createInlineCompletionPlugin(
							(args, signal) =>
								inlineCompletionRequestRef.current?.(args, signal) ??
								Promise.resolve(null),
						)
					: [],
			),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChangeRef.current?.(update.state.doc.toString());
				}
			}),
			suppressInsertions,
			blameCompartmentB.of([]),
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
					diagnosticsCompartmentB.of([
						createDiagnosticsTheme(editorTheme),
						EditorView.decorations.of(
							buildDiagnosticDecorations(
								EditorState.create({ doc: modified }).doc,
								diagnostics,
							),
						),
					]),
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

	useEffect(() => {
		const mv = mergeViewRef.current;
		if (!mv) return;

		mv.b.dispatch({
			effects: diagnosticsCompartmentB.reconfigure([
				createDiagnosticsTheme(editorTheme),
				EditorView.decorations.of(
					buildDiagnosticDecorations(mv.b.state.doc, diagnostics),
				),
			]),
		});
	}, [diagnostics, diagnosticsCompartmentB, editorTheme]);

	useEffect(() => {
		const mv = mergeViewRef.current;
		if (!mv) return;

		mv.b.dispatch({
			effects: blameCompartmentB.reconfigure(
				blameEntries ? createBlamePlugin(blameEntries, { worktreePath }) : [],
			),
		});
	}, [blameEntries, blameCompartmentB, worktreePath]);

	const hasInlineCompletionRequest = Boolean(inlineCompletionRequest);
	useEffect(() => {
		const mv = mergeViewRef.current;
		if (!mv) return;

		mv.b.dispatch({
			effects: inlineCompletionCompartmentB.reconfigure(
				hasInlineCompletionRequest
					? createInlineCompletionPlugin(
							(args, signal) =>
								inlineCompletionRequestRef.current?.(args, signal) ??
								Promise.resolve(null),
						)
					: [],
			),
		});
	}, [inlineCompletionCompartmentB, hasInlineCompletionRequest]);

	return <div ref={containerRef} className="h-full w-full overflow-auto" />;
}
