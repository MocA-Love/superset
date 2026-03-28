import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightSpecialChars,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { createCodeMirrorTheme } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createCodeMirrorTheme";
import { loadLanguageSupport } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/loadLanguageSupport";
import { getCodeSyntaxHighlighting } from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { useResolvedTheme } from "renderer/stores/theme";
import type { DiffViewMode } from "shared/changes-types";

interface CodeMirrorDiffViewerProps {
	original: string;
	modified: string;
	language: string;
	viewMode: DiffViewMode;
}

export function CodeMirrorDiffViewer({
	original,
	modified,
	language,
	viewMode,
}: CodeMirrorDiffViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mergeViewRef = useRef<MergeView | null>(null);
	const langCompartmentA = useRef(new Compartment()).current;
	const langCompartmentB = useRef(new Compartment()).current;
	const themeCompartmentA = useRef(new Compartment()).current;
	const themeCompartmentB = useRef(new Compartment()).current;
	const activeTheme = useResolvedTheme();
	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{ staleTime: 30_000 },
	);
	const editorFontFamily = fontSettings?.editorFontFamily ?? undefined;
	const editorFontSize = fontSettings?.editorFontSize ?? undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: MergeView is created once and destroyed on unmount
	useEffect(() => {
		if (!containerRef.current) return;

		const baseExtensions = [
			lineNumbers(),
			highlightSpecialChars(),
			drawSelection(),
			highlightSelectionMatches(),
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			EditorView.lineWrapping,
			keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap]),
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
			a: {
				doc: original,
				extensions: [
					...baseExtensions,
					themeCompartmentA.of(themeExts),
					langCompartmentA.of([]),
				],
			},
			b: {
				doc: modified,
				extensions: [
					...baseExtensions,
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
