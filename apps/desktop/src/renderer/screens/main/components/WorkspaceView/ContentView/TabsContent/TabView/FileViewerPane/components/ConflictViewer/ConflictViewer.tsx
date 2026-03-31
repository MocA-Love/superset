import { defaultKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	lineNumbers,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { createCodeMirrorTheme } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createCodeMirrorTheme";
import { loadLanguageSupport } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/loadLanguageSupport";
import { getCodeSyntaxHighlighting } from "renderer/screens/main/components/WorkspaceView/utils/code-theme";
import { useResolvedTheme } from "renderer/stores/theme";
import { detectLanguage } from "shared/detect-language";
import {
	ConflictActionWidget,
	type ConflictResolution,
} from "./ConflictActionWidget";
import { conflictTheme } from "./conflict-theme";
import {
	type ConflictRegion,
	parseConflictMarkers,
} from "./parseConflictMarkers";

interface ConflictViewerProps {
	workspaceId: string;
	absoluteFilePath: string;
	onSave?: () => void;
}

const MAX_CONFLICT_FILE_SIZE = 2 * 1024 * 1024;

function buildConflictDecorations(
	doc: EditorState["doc"],
	regions: ConflictRegion[],
	onResolve: (regionIndex: number, resolution: ConflictResolution) => void,
): DecorationSet {
	const decorations: Range<Decoration>[] = [];

	for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
		const region = regions[regionIndex];
		if (!region) continue;

		// Action widget above the <<< marker
		const markerLine = doc.line(region.startLine);
		decorations.push(
			Decoration.widget({
				widget: new ConflictActionWidget({ regionIndex, onResolve }),
				side: -1,
			}).range(markerLine.from),
		);

		// <<<<<<< marker line
		decorations.push(
			Decoration.line({ class: "cm-conflict-marker" }).range(markerLine.from),
		);

		// current side lines
		for (const { lineNumber } of region.currentLines) {
			if (lineNumber > doc.lines) continue;
			const line = doc.line(lineNumber);
			decorations.push(
				Decoration.line({ class: "cm-conflict-current" }).range(line.from),
			);
		}

		// ======= separator
		if (region.separatorLine <= doc.lines) {
			const sep = doc.line(region.separatorLine);
			decorations.push(
				Decoration.line({ class: "cm-conflict-separator" }).range(sep.from),
			);
		}

		// incoming side lines
		for (const { lineNumber } of region.incomingLines) {
			if (lineNumber > doc.lines) continue;
			const line = doc.line(lineNumber);
			decorations.push(
				Decoration.line({ class: "cm-conflict-incoming" }).range(line.from),
			);
		}

		// >>>>>>> end marker line
		if (region.endLine <= doc.lines) {
			const end = doc.line(region.endLine);
			decorations.push(
				Decoration.line({ class: "cm-conflict-marker" }).range(end.from),
			);
		}
	}

	decorations.sort(
		(a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
	);
	return Decoration.set(decorations, true);
}

function applyResolution(
	content: string,
	regions: ConflictRegion[],
	regionIndex: number,
	resolution: ConflictResolution,
): string {
	const region = regions[regionIndex];
	if (!region) return content;

	const lines = content.split("\n");

	let replacementLines: string[];
	switch (resolution) {
		case "current":
			replacementLines = region.currentLines.map((l) => l.text);
			break;
		case "incoming":
			replacementLines = region.incomingLines.map((l) => l.text);
			break;
		case "both":
			replacementLines = [
				...region.currentLines.map((l) => l.text),
				...region.incomingLines.map((l) => l.text),
			];
			break;
	}

	// Replace from startLine to endLine (1-based, inclusive)
	const before = lines.slice(0, region.startLine - 1);
	const after = lines.slice(region.endLine);

	return [...before, ...replacementLines, ...after].join("\n");
}

export function ConflictViewer({
	workspaceId,
	absoluteFilePath,
	onSave,
}: ConflictViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<EditorView | null>(null);
	const contentRef = useRef<string>("");
	const regionsRef = useRef<ConflictRegion[]>([]);
	const activeTheme = useResolvedTheme();
	// Use refs for callbacks to avoid re-creating the editor on every render
	const handleResolveRef = useRef<
		(regionIndex: number, resolution: ConflictResolution) => void
	>(() => {});
	const handleSaveRef = useRef<() => void>(() => {});

	const {
		data: fileData,
		error: fileError,
		isLoading: isLoadingFile,
		refetch,
	} = electronTrpc.filesystem.readFile.useQuery(
		{
			workspaceId,
			absolutePath: absoluteFilePath,
			encoding: "utf-8",
			maxBytes: MAX_CONFLICT_FILE_SIZE,
		},
		{
			enabled: Boolean(
				workspaceId && absoluteFilePath && absoluteFilePath !== "",
			),
			refetchOnWindowFocus: false,
			retry: false,
		},
	);

	const writeFileMutation = electronTrpc.filesystem.writeFile.useMutation({
		onSuccess: () => {
			refetch().catch(() => {});
			onSave?.();
		},
	});

	const handleResolve = useCallback(
		(regionIndex: number, resolution: ConflictResolution) => {
			const newContent = applyResolution(
				contentRef.current,
				regionsRef.current,
				regionIndex,
				resolution,
			);
			writeFileMutation.mutate({
				workspaceId,
				absolutePath: absoluteFilePath,
				content: newContent,
				options: { create: false, overwrite: true },
			});
		},
		[workspaceId, absoluteFilePath, writeFileMutation],
	);

	const handleSave = useCallback(() => {
		const editor = editorRef.current;
		if (!editor) return;
		const newContent = editor.state.doc.toString();
		writeFileMutation.mutate({
			workspaceId,
			absolutePath: absoluteFilePath,
			content: newContent,
			options: { create: false, overwrite: true },
		});
	}, [workspaceId, absoluteFilePath, writeFileMutation]);

	// Keep refs up-to-date so the editor plugin always uses the latest callbacks
	handleResolveRef.current = handleResolve;
	handleSaveRef.current = handleSave;

	useEffect(() => {
		if (!containerRef.current) return;
		if (editorRef.current) return;

		const language = detectLanguage(absoluteFilePath);
		const editorTheme = createCodeMirrorTheme(activeTheme, {}, true);
		const syntaxHighlighting = getCodeSyntaxHighlighting(activeTheme);
		const langCompartment = new Compartment();

		const conflictPlugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					const content = view.state.doc.toString();
					const regions = parseConflictMarkers(content);
					regionsRef.current = regions;
					contentRef.current = content;
					this.decorations = buildConflictDecorations(
						view.state.doc,
						regions,
						(idx, res) => handleResolveRef.current(idx, res),
					);
				}

				update(update: ViewUpdate) {
					if (update.docChanged) {
						const content = update.view.state.doc.toString();
						const regions = parseConflictMarkers(content);
						regionsRef.current = regions;
						contentRef.current = content;
						this.decorations = buildConflictDecorations(
							update.view.state.doc,
							regions,
							(idx, res) => handleResolveRef.current(idx, res),
						);
					}
				}
			},
			{ decorations: (v) => v.decorations },
		);

		const saveKeymap = keymap.of([
			{
				key: "Mod-s",
				run: () => {
					handleSaveRef.current();
					return true;
				},
			},
		]);

		const state = EditorState.create({
			doc: "",
			extensions: [
				lineNumbers(),
				editorTheme,
				syntaxHighlighting,
				conflictTheme,
				conflictPlugin,
				saveKeymap,
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
				langCompartment.of([]),
			],
		});

		const view = new EditorView({
			state,
			parent: containerRef.current,
		});

		editorRef.current = view;

		void loadLanguageSupport(language).then((ext) => {
			if (!ext || !editorRef.current) return;
			editorRef.current.dispatch({
				effects: langCompartment.reconfigure(ext),
			});
		});

		return () => {
			view.destroy();
			editorRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [absoluteFilePath, activeTheme]);

	// Load file content into editor when fetched
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || !fileData || fileData.kind !== "text") return;

		const content = fileData.content;

		if (content === editor.state.doc.toString()) return;

		editor.dispatch({
			changes: {
				from: 0,
				to: editor.state.doc.length,
				insert: content,
			},
		});
	}, [fileData]);

	const overlayMessage = fileError
		? `Failed to load conflicted file: ${fileError.message}`
		: fileData?.kind && fileData.kind !== "text"
			? "Conflict viewer only supports text files."
			: fileData?.exceededLimit
				? `File exceeds ${MAX_CONFLICT_FILE_SIZE / 1024 / 1024}MB and was truncated.`
				: null;

	return (
		<div className="relative h-full w-full bg-background">
			<div
				ref={containerRef}
				className="h-full w-full overflow-auto bg-background select-text"
			/>
			{isLoadingFile && !fileData ? (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 text-sm text-muted-foreground">
					Loading conflicted file...
				</div>
			) : null}
			{overlayMessage ? (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/90 p-6 text-center text-sm text-muted-foreground">
					{overlayMessage}
				</div>
			) : null}
		</div>
	);
}
