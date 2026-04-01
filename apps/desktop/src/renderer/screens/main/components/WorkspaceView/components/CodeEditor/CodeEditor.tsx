import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	selectAll,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import {
	highlightSelectionMatches,
	openSearchPanel,
	searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { cn } from "@superset/ui/utils";
import { type MutableRefObject, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { CodeEditorAdapter } from "renderer/screens/main/components/WorkspaceView/ContentView/components";
import { getCodeSyntaxHighlighting } from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { getEditorTheme } from "shared/themes";
import { useResolvedTheme } from "renderer/stores/theme";
import { type BlameEntry, createBlamePlugin } from "./createBlamePlugin";
import { createCodeMirrorTheme } from "./createCodeMirrorTheme";
import { loadLanguageSupport } from "./loadLanguageSupport";

interface CodeEditorProps {
	value: string;
	language: string;
	worktreePath?: string;
	readOnly?: boolean;
	fillHeight?: boolean;
	className?: string;
	editorRef?: MutableRefObject<CodeEditorAdapter | null>;
	onChange?: (value: string) => void;
	onSave?: () => void;
	blameEntries?: BlameEntry[];
}

const HIGHLIGHT_CLEAR_DELAY_MS = 1800;
const HIGHLIGHT_RETRY_DELAY_MS = 80;
const HIGHLIGHT_MAX_RETRIES = 8;
const SCROLL_STABILIZE_DELAY_MS = 120;

function createCodeMirrorAdapter(
	view: EditorView,
	jumpHighlightStyle: {
		backgroundColor: string;
		boxShadow: string;
	},
): CodeEditorAdapter {
	let disposed = false;
	let highlightResetTimeout: ReturnType<typeof setTimeout> | null = null;
	let scrollStabilizeTimeout: ReturnType<typeof setTimeout> | null = null;
	let highlightedLine: HTMLElement | null = null;
	let highlightAnimation: Animation | null = null;
	let highlightedLinePreviousStyle:
		| {
				backgroundColor: string;
				boxShadow: string;
				outline: string;
				outlineOffset: string;
				borderRadius: string;
				transition: string;
		  }
		| null = null;

	const clearLineHighlight = () => {
		if (!highlightedLine) {
			return;
		}

		if (highlightedLinePreviousStyle) {
			highlightedLine.style.backgroundColor =
				highlightedLinePreviousStyle.backgroundColor;
			highlightedLine.style.boxShadow = highlightedLinePreviousStyle.boxShadow;
			highlightedLine.style.outline = highlightedLinePreviousStyle.outline;
			highlightedLine.style.outlineOffset =
				highlightedLinePreviousStyle.outlineOffset;
			highlightedLine.style.borderRadius =
				highlightedLinePreviousStyle.borderRadius;
			highlightedLine.style.transition = highlightedLinePreviousStyle.transition;
		} else {
			highlightedLine.style.removeProperty("background-color");
			highlightedLine.style.removeProperty("box-shadow");
			highlightedLine.style.removeProperty("outline");
			highlightedLine.style.removeProperty("outline-offset");
			highlightedLine.style.removeProperty("border-radius");
			highlightedLine.style.removeProperty("transition");
		}

		highlightAnimation?.cancel();
		highlightAnimation = null;
		highlightedLine = null;
		highlightedLinePreviousStyle = null;
	};

	const highlightLineAt = (anchor: number, attempt = 0) => {
		window.setTimeout(() => {
			if (disposed) {
				return;
			}

			const domAtPos = view.domAtPos(anchor);
			const domNode =
				domAtPos.node instanceof HTMLElement
					? domAtPos.node
					: domAtPos.node.parentElement;
			const lineElement = domNode?.closest(".cm-line");
			if (!(lineElement instanceof HTMLElement)) {
				if (attempt < HIGHLIGHT_MAX_RETRIES) {
					highlightLineAt(anchor, attempt + 1);
				}
				return;
			}

			clearLineHighlight();
			highlightedLinePreviousStyle = {
				backgroundColor: lineElement.style.backgroundColor,
				boxShadow: lineElement.style.boxShadow,
				outline: lineElement.style.outline,
				outlineOffset: lineElement.style.outlineOffset,
				borderRadius: lineElement.style.borderRadius,
				transition: lineElement.style.transition,
			};
			lineElement.style.transition =
				"background-color 1.2s ease-out, box-shadow 1.2s ease-out, outline-color 1.2s ease-out";
			lineElement.style.backgroundColor = jumpHighlightStyle.backgroundColor;
			lineElement.style.boxShadow = jumpHighlightStyle.boxShadow;
			lineElement.style.outline = `2px solid ${jumpHighlightStyle.backgroundColor}`;
			lineElement.style.outlineOffset = "-1px";
			lineElement.style.borderRadius = "4px";
			highlightedLine = lineElement;
			highlightAnimation = lineElement.animate(
				[
					{
						backgroundColor: jumpHighlightStyle.backgroundColor,
						boxShadow: jumpHighlightStyle.boxShadow,
						outlineColor: jumpHighlightStyle.backgroundColor,
					},
					{
						backgroundColor: jumpHighlightStyle.backgroundColor,
						boxShadow: jumpHighlightStyle.boxShadow,
						outlineColor: jumpHighlightStyle.backgroundColor,
						offset: 0.35,
					},
					{
						backgroundColor:
							highlightedLinePreviousStyle?.backgroundColor || "transparent",
						boxShadow: highlightedLinePreviousStyle?.boxShadow || "none",
						outlineColor: "transparent",
					},
				],
				{
					duration: HIGHLIGHT_CLEAR_DELAY_MS,
					easing: "ease-out",
					fill: "forwards",
				},
			);
		}, attempt === 0 ? 32 : HIGHLIGHT_RETRY_DELAY_MS);
	};

	return {
		focus() {
			view.focus();
		},
		getValue() {
			return view.state.doc.toString();
		},
		setValue(value) {
			view.dispatch({
				changes: {
					from: 0,
					to: view.state.doc.length,
					insert: value,
				},
			});
		},
		revealPosition(line, column = 1) {
			const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
			const lineInfo = view.state.doc.line(safeLine);
			const offset = Math.min(column - 1, lineInfo.length);
			const anchor = lineInfo.from + Math.max(0, offset);

			if (highlightResetTimeout) {
				clearTimeout(highlightResetTimeout);
				highlightResetTimeout = null;
			}

			view.dispatch({
		selection: EditorSelection.cursor(anchor),
				effects: EditorView.scrollIntoView(anchor, {
					y: "center",
					yMargin: 48,
				}),
			});
			highlightLineAt(anchor);
			if (scrollStabilizeTimeout) {
				clearTimeout(scrollStabilizeTimeout);
			}
			scrollStabilizeTimeout = setTimeout(() => {
				if (disposed) {
					return;
				}

				view.dispatch({
					effects: EditorView.scrollIntoView(anchor, {
						y: "center",
						yMargin: 48,
					}),
				});
				scrollStabilizeTimeout = null;
			}, SCROLL_STABILIZE_DELAY_MS);

			highlightResetTimeout = setTimeout(() => {
				if (disposed) {
					return;
				}

				clearLineHighlight();
				highlightResetTimeout = null;
			}, HIGHLIGHT_CLEAR_DELAY_MS);

			view.focus();
		},
		getSelectionLines() {
			const selection = view.state.selection.main;
			const startLine = view.state.doc.lineAt(selection.from).number;
			const endLine = view.state.doc.lineAt(selection.to).number;
			return { startLine, endLine };
		},
		selectAll() {
			selectAll(view);
		},
		cut() {
			if (view.state.readOnly) return;
			const clipboard = navigator.clipboard;
			if (!clipboard) return;

			const selection = view.state.selection.main;
			if (selection.empty) return;

			const text = view.state.sliceDoc(selection.from, selection.to);
			void clipboard
				.writeText(text)
				.then(() => {
					const currentSelection = view.state.selection.main;
					if (
						currentSelection.from !== selection.from ||
						currentSelection.to !== selection.to
					) {
						return;
					}

					if (view.state.sliceDoc(selection.from, selection.to) !== text) {
						return;
					}

					view.dispatch({
						changes: { from: selection.from, to: selection.to, insert: "" },
					});
				})
				.catch((error) => {
					console.error("[CodeEditor] Failed to cut selection:", error);
				});
		},
		copy() {
			const clipboard = navigator.clipboard;
			if (!clipboard) return;

			const selection = view.state.selection.main;
			if (selection.empty) return;

			void clipboard
				.writeText(view.state.sliceDoc(selection.from, selection.to))
				.catch((error) => {
					console.error("[CodeEditor] Failed to copy selection:", error);
				});
		},
		paste() {
			if (view.state.readOnly) return;
			const clipboard = navigator.clipboard;
			if (!clipboard) return;

			void clipboard
				.readText()
				.then((text) => {
					const selection = view.state.selection.main;
					view.dispatch({
						changes: {
							from: selection.from,
							to: selection.to,
							insert: text,
						},
						selection: EditorSelection.cursor(selection.from + text.length),
					});
				})
				.catch((error) => {
					console.error("[CodeEditor] Failed to paste from clipboard:", error);
				});
		},
		openFind() {
			openSearchPanel(view);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (highlightResetTimeout) {
				clearTimeout(highlightResetTimeout);
				highlightResetTimeout = null;
			}
			if (scrollStabilizeTimeout) {
				clearTimeout(scrollStabilizeTimeout);
				scrollStabilizeTimeout = null;
			}
			clearLineHighlight();
			view.destroy();
		},
	};
}

export function CodeEditor({
	value,
	language,
	worktreePath,
	readOnly = false,
	fillHeight = true,
	className,
	editorRef,
	onChange,
	onSave,
	blameEntries,
}: CodeEditorProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const languageCompartment = useRef(new Compartment()).current;
	const themeCompartment = useRef(new Compartment()).current;
	const editableCompartment = useRef(new Compartment()).current;
	const blameCompartment = useRef(new Compartment()).current;
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	// Guards against re-entrant onChange calls triggered by the value-sync effect's own dispatch.
	const isExternalUpdateRef = useRef(false);
	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{
			staleTime: 30_000,
		},
	);
	const editorFontFamily = fontSettings?.editorFontFamily ?? undefined;
	const editorFontSize = fontSettings?.editorFontSize ?? undefined;
	const activeTheme = useResolvedTheme();
	const editorTheme = getEditorTheme(activeTheme);

	onChangeRef.current = onChange;
	onSaveRef.current = onSave;

	// biome-ignore lint/correctness/useExhaustiveDependencies: Editor instance is created once and reconfigured via dedicated effects below
	useEffect(() => {
		if (!containerRef.current) return;

		const updateListener = EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			if (isExternalUpdateRef.current) return;
			onChangeRef.current?.(update.state.doc.toString());
		});

		const saveKeymap = keymap.of([
			{
				key: "Mod-s",
				run: () => {
					onSaveRef.current?.();
					return true;
				},
			},
		]);

		const state = EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				bracketMatching(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				EditorView.lineWrapping,
				editableCompartment.of([
					EditorState.readOnly.of(readOnly),
					EditorView.editable.of(!readOnly),
				]),
				EditorView.contentAttributes.of({
					"data-testid": "code-editor",
					spellcheck: "false",
				}),
				keymap.of([
					indentWithTab,
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
				]),
				saveKeymap,
				themeCompartment.of([
					getCodeSyntaxHighlighting(activeTheme),
					createCodeMirrorTheme(
						activeTheme,
						{
							fontFamily: editorFontFamily,
							fontSize: editorFontSize,
						},
						fillHeight,
					),
				]),
				languageCompartment.of([]),
				blameCompartment.of([]),
				updateListener,
			],
		});

		const view = new EditorView({
			state,
			parent: containerRef.current,
		});
		const adapter = createCodeMirrorAdapter(view, {
			backgroundColor: editorTheme.colors.search,
			boxShadow: `inset 2px 0 0 ${editorTheme.colors.searchActive}`,
		});

		viewRef.current = view;
		if (editorRef) {
			editorRef.current = adapter;
		}

		return () => {
			if (editorRef?.current === adapter) {
				editorRef.current = null;
			}
			adapter.dispose();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;

		const currentValue = view.state.doc.toString();
		if (currentValue === value) return;

		// Guarantee flag reset regardless of whether dispatch throws (e.g. view destroyed between null-check and dispatch).
		isExternalUpdateRef.current = true;
		try {
			view.dispatch({
				changes: {
					from: 0,
					to: view.state.doc.length,
					insert: value,
				},
			});
		} finally {
			isExternalUpdateRef.current = false;
		}
	}, [value]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;

		view.dispatch({
			effects: themeCompartment.reconfigure([
				getCodeSyntaxHighlighting(activeTheme),
				createCodeMirrorTheme(
					activeTheme,
					{
						fontFamily: editorFontFamily,
						fontSize: editorFontSize,
					},
					fillHeight,
				),
			]),
		});
	}, [
		activeTheme,
		editorFontFamily,
		editorFontSize,
		fillHeight,
		themeCompartment,
	]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;

		view.dispatch({
			effects: editableCompartment.reconfigure([
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			]),
		});
	}, [editableCompartment, readOnly]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;

		view.dispatch({
			effects: blameCompartment.reconfigure(
				blameEntries ? createBlamePlugin(blameEntries, { worktreePath }) : [],
			),
		});
	}, [blameEntries, blameCompartment, worktreePath]);

	useEffect(() => {
		let cancelled = false;

		void loadLanguageSupport(language)
			.then((extension) => {
				if (cancelled) return;
				const view = viewRef.current;
				if (!view) return;

				view.dispatch({
					effects: languageCompartment.reconfigure(extension ?? []),
				});
			})
			.catch((error) => {
				if (cancelled) return;
				const view = viewRef.current;
				if (!view) return;

				console.error("[CodeEditor] Failed to load language support:", {
					error,
					language,
				});
				view.dispatch({
					effects: languageCompartment.reconfigure([]),
				});
			});

		return () => {
			cancelled = true;
		};
	}, [language, languageCompartment]);

	return (
		<div
			ref={containerRef}
			className={cn(
				"min-w-0",
				fillHeight ? "h-full w-full" : "w-full",
				className,
			)}
		/>
	);
}
