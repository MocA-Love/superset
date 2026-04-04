import {
	type MutableRefObject,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { LuLoader } from "react-icons/lu";
import {
	type MarkdownEditorAdapter,
	TipTapMarkdownRenderer,
} from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { CodeEditorAdapter } from "renderer/screens/main/components/WorkspaceView/ContentView/components";
import { CodeEditor } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor";
import type { Tab } from "renderer/stores/tabs/types";
import { pathsMatch, toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { DiffViewMode } from "shared/changes-types";
import { detectLanguage } from "shared/detect-language";
import {
	isHtmlFile,
	isImageFile,
	isPdfFile,
	isSpreadsheetFile,
} from "shared/file-types";
import type { FileViewerMode } from "shared/tabs-types";
import { useScrollToFirstDiffChange } from "../../hooks/useScrollToFirstDiffChange";
import { CodeMirrorDiffViewer } from "../CodeMirrorDiffViewer";
import { ConflictViewer } from "../ConflictViewer";
import { DiffViewerContextMenu } from "../DiffViewerContextMenu";
import { FileEditorContextMenu } from "../FileEditorContextMenu";
import { MarkdownSearch } from "../MarkdownSearch";
import { SpreadsheetDiffViewer, SpreadsheetViewer } from "../SpreadsheetViewer";
import {
	type DiffDomLocation,
	getColumnFromDiffPoint,
	getDiffLocationFromEvent,
	mapDiffLocationToRawPosition,
} from "./utils/diff-location";

function HtmlPreviewWebview({ absolutePath }: { absolutePath: string }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !absolutePath) return;

		const webview = document.createElement("webview") as Electron.WebviewTag;
		webview.src = `file://${absolutePath}`;
		webview.setAttribute(
			"webpreferences",
			"sandbox=true,nodeIntegration=false,contextIsolation=true",
		);
		webview.style.width = "100%";
		webview.style.height = "100%";
		webview.style.border = "none";

		webview.addEventListener("will-navigate", (e) => {
			e.preventDefault();
		});

		container.appendChild(webview);

		return () => {
			try {
				if (webview.isConnected) {
					webview.stop();
				}
				container.removeChild(webview);
			} catch {
				// already removed
			}
		};
	}, [absolutePath]);

	return <div ref={containerRef} className="h-full w-full bg-white" />;
}

function PdfPreviewWebview({ absolutePath }: { absolutePath: string }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !absolutePath) return;

		const webview = document.createElement("webview") as Electron.WebviewTag;
		webview.src = `file://${absolutePath}`;
		webview.setAttribute(
			"webpreferences",
			"sandbox=true,nodeIntegration=false,contextIsolation=true,plugins=true",
		);
		webview.style.width = "100%";
		webview.style.height = "100%";
		webview.style.border = "none";

		webview.addEventListener("will-navigate", (e) => {
			e.preventDefault();
		});

		container.appendChild(webview);

		return () => {
			try {
				if (webview.isConnected) {
					webview.stop();
				}
				container.removeChild(webview);
			} catch {
				// already removed
			}
		};
	}, [absolutePath]);

	return <div ref={containerRef} className="h-full w-full bg-background" />;
}

interface RawFileData {
	ok: true;
	content: string;
}

interface RawFileError {
	ok: false;
	reason: "too-large" | "binary" | "not-found" | "is-directory";
}

type RawFileResult = RawFileData | RawFileError | undefined;

interface ImageData {
	ok: true;
	dataUrl: string;
	byteLength: number;
}

interface ImageError {
	ok: false;
	reason: "too-large" | "not-image" | "not-found" | "is-directory";
}

type ImageResult = ImageData | ImageError | undefined;

interface DiffData {
	original: string;
	modified: string;
	language: string;
}

function hasActiveSelectionWithinElement(
	element: HTMLDivElement | null,
): boolean {
	if (!element) {
		return false;
	}

	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return false;
	}

	const text = selection.toString();
	if (text.length === 0) {
		return false;
	}

	for (let index = 0; index < selection.rangeCount; index += 1) {
		const range = selection.getRangeAt(index);
		if (element.contains(range.commonAncestorContainer)) {
			return true;
		}
	}

	return false;
}

interface TextSearchState {
	isSearchOpen: boolean;
	query: string;
	caseSensitive: boolean;
	matchCount: number;
	activeMatchIndex: number;
	setQuery: (query: string) => void;
	setCaseSensitive: (caseSensitive: boolean) => void;
	findNext: () => void;
	findPrevious: () => void;
	closeSearch: () => void;
}

interface FileViewerContentProps {
	workspaceId?: string;
	worktreePath?: string;
	diffCategory?: import("shared/changes-types").ChangeCategory;
	commitHash?: string;
	viewMode: FileViewerMode;
	filePath: string;
	isLoadingRaw: boolean;
	isLoadingImage?: boolean;
	isLoadingDiff: boolean;
	rawFileData: RawFileResult;
	imageData?: ImageResult;
	diffData: DiffData | undefined;
	editorRef: MutableRefObject<CodeEditorAdapter | null>;
	markdownEditorRef: MutableRefObject<MarkdownEditorAdapter | null>;
	renderedContent: string;
	initialLine?: number;
	initialColumn?: number;
	diffViewMode: DiffViewMode;
	hideUnchangedRegions: boolean;
	onSaveFile: () => void;
	onContentChange: (value: string | undefined) => void;
	onSwitchToRawAtLocation: (line: number, column: number) => void;
	onSplitHorizontal: () => void;
	onSplitVertical: () => void;
	onSplitWithNewChat?: () => void;
	onSplitWithNewBrowser?: () => void;
	onEqualizePaneSplits?: () => void;
	onClosePane: () => void;
	currentTabId: string;
	availableTabs: Tab[];
	onMoveToTab: (tabId: string) => void;
	onMoveToNewTab: () => void;
	diffContainerRef: RefObject<HTMLDivElement | null>;
	diffSearch: TextSearchState;
	markdownContainerRef: RefObject<HTMLDivElement | null>;
	markdownSearch: TextSearchState;
}

export function FileViewerContent({
	workspaceId,
	worktreePath,
	diffCategory,
	commitHash,
	viewMode,
	filePath,
	isLoadingRaw,
	isLoadingImage,
	isLoadingDiff,
	rawFileData,
	imageData,
	diffData,
	editorRef,
	markdownEditorRef,
	renderedContent,
	initialLine,
	initialColumn,
	diffViewMode,
	hideUnchangedRegions,
	onSaveFile,
	onContentChange,
	onSwitchToRawAtLocation,
	onSplitHorizontal,
	onSplitVertical,
	onSplitWithNewChat,
	onSplitWithNewBrowser,
	onEqualizePaneSplits,
	onClosePane,
	currentTabId,
	availableTabs,
	onMoveToTab,
	onMoveToNewTab,
	diffContainerRef,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future use
	diffSearch,
	markdownContainerRef,
	markdownSearch,
}: FileViewerContentProps) {
	const isImage = isImageFile(filePath);
	const isHtml = isHtmlFile(filePath);
	const isPdf = isPdfFile(filePath);

	useScrollToFirstDiffChange({
		containerRef: diffContainerRef,
		filePath,
		diffData,
		enabled: viewMode === "diff" && !isLoadingDiff && !!diffData,
	});

	const absoluteFilePath = useMemo(
		() => (worktreePath ? toAbsoluteWorkspacePath(worktreePath, filePath) : ""),
		[worktreePath, filePath],
	);
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const projectId = workspace?.projectId ?? workspace?.project?.id;
	const { data: project } = electronTrpc.projects.get.useQuery(
		{ id: projectId ?? "" },
		{ enabled: !!projectId },
	);
	const supersetLinkProject = useMemo(
		() =>
			project
				? {
						githubOwner: project.githubOwner ?? null,
						githubRepoName: null,
						mainRepoPath: project.mainRepoPath,
					}
				: null,
		[project],
	);

	const trpcUtils = electronTrpc.useUtils();
	const { data: workspaceDiagnostics } =
		electronTrpc.languageServices.getWorkspaceDiagnostics.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{
				enabled: Boolean(workspaceId),
				staleTime: Infinity,
			},
		);

	electronTrpc.languageServices.subscribeDiagnostics.useSubscription(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: Boolean(workspaceId),
			onData: () => {
				if (!workspaceId) {
					return;
				}
				void trpcUtils.languageServices.getWorkspaceDiagnostics.invalidate({
					workspaceId,
				});
			},
		},
	);

	const fileDiagnostics = useMemo(
		() =>
			(workspaceDiagnostics?.problems ?? []).filter(
				(problem) =>
					(problem.absolutePath && absoluteFilePath
						? pathsMatch(problem.absolutePath, absoluteFilePath)
						: false) || problem.relativePath === filePath,
			),
		[workspaceDiagnostics?.problems, absoluteFilePath, filePath],
	);

	const { data: blameData } = electronTrpc.changes.getGitBlame.useQuery(
		{ worktreePath: worktreePath ?? "", absolutePath: absoluteFilePath },
		{
			enabled: Boolean(worktreePath && absoluteFilePath),
			staleTime: 60_000,
		},
	);

	const hasAppliedInitialLocationRef = useRef(false);
	const lastDiffLocationRef = useRef<
		| (DiffDomLocation & {
				column?: number;
		  })
		| null
	>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset on file change only
	useEffect(() => {
		hasAppliedInitialLocationRef.current = false;
	}, [filePath]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset when requested cursor target changes
	useEffect(() => {
		hasAppliedInitialLocationRef.current = false;
	}, [initialLine, initialColumn]);

	useEffect(() => {
		if (viewMode !== "raw") {
			hasAppliedInitialLocationRef.current = false;
		}
	}, [viewMode]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset cached diff interaction when the rendered diff changes
	useEffect(() => {
		lastDiffLocationRef.current = null;
	}, [
		filePath,
		diffData?.original,
		diffData?.modified,
		diffViewMode,
		hideUnchangedRegions,
	]);

	const getDiffSelectionLines = () => {
		if (!diffData || !lastDiffLocationRef.current) {
			return null;
		}

		const position = mapDiffLocationToRawPosition({
			contents: diffData,
			lineNumber: lastDiffLocationRef.current.lineNumber,
			side: lastDiffLocationRef.current.side,
			lineType: lastDiffLocationRef.current.lineType,
		});

		return {
			startLine: position.lineNumber,
			endLine: position.lineNumber,
		};
	};

	const openRawFromDiffLocation = (
		location: DiffDomLocation & {
			column: number;
		},
	) => {
		if (!diffData) {
			return;
		}

		lastDiffLocationRef.current = location;

		const position = mapDiffLocationToRawPosition({
			contents: diffData,
			lineNumber: location.lineNumber,
			side: location.side,
			lineType: location.lineType,
			column: location.column,
		});

		onSwitchToRawAtLocation(position.lineNumber, position.column);
	};

	useEffect(() => {
		if (
			viewMode !== "raw" ||
			!editorRef.current ||
			!initialLine ||
			hasAppliedInitialLocationRef.current ||
			isLoadingRaw ||
			!rawFileData?.ok
		) {
			return;
		}

		editorRef.current.revealPosition(initialLine, initialColumn ?? 1);
		hasAppliedInitialLocationRef.current = true;
	}, [
		viewMode,
		editorRef,
		initialLine,
		initialColumn,
		isLoadingRaw,
		rawFileData,
	]);

	if (
		viewMode === "diff" &&
		isSpreadsheetFile(filePath) &&
		workspaceId &&
		worktreePath
	) {
		return (
			<SpreadsheetDiffViewer
				workspaceId={workspaceId}
				worktreePath={worktreePath}
				filePath={filePath}
				absoluteFilePath={absoluteFilePath}
				diffCategory={diffCategory}
				commitHash={commitHash}
			/>
		);
	}

	if (viewMode === "conflict" && workspaceId) {
		return (
			<ConflictViewer
				workspaceId={workspaceId}
				absoluteFilePath={absoluteFilePath}
			/>
		);
	}

	if (viewMode === "diff") {
		if (isLoadingDiff) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					Loading diff...
				</div>
			);
		}

		if (!diffData) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					No diff available
				</div>
			);
		}

		return (
			<DiffViewerContextMenu
				containerRef={diffContainerRef}
				filePath={filePath}
				branch={workspace?.branch}
				worktreePath={worktreePath}
				supersetLinkProject={supersetLinkProject}
				getSelectionLines={getDiffSelectionLines}
				onSplitHorizontal={onSplitHorizontal}
				onSplitVertical={onSplitVertical}
				onSplitWithNewChat={onSplitWithNewChat}
				onSplitWithNewBrowser={onSplitWithNewBrowser}
				onEqualizePaneSplits={onEqualizePaneSplits}
				onClosePane={onClosePane}
				currentTabId={currentTabId}
				availableTabs={availableTabs}
				onMoveToTab={onMoveToTab}
				onMoveToNewTab={onMoveToNewTab}
				onEditAtLocation={() => {
					const location = lastDiffLocationRef.current;
					if (!location || location.column === undefined) {
						return;
					}

					openRawFromDiffLocation({
						...location,
						column: location.column,
					});
				}}
			>
				<div className="relative h-full">
					<div
						ref={diffContainerRef}
						className="h-full min-h-0 overflow-auto bg-background select-text"
						onClickCapture={(event) => {
							if (hasActiveSelectionWithinElement(diffContainerRef.current)) {
								event.stopPropagation();
							}
						}}
						onContextMenuCapture={(event) => {
							const nativeEvent = event.nativeEvent;
							const location = getDiffLocationFromEvent(nativeEvent);
							if (!location) {
								lastDiffLocationRef.current = null;
								return;
							}

							const column = getColumnFromDiffPoint({
								lineElement: event.target as HTMLElement,
								clientX: event.clientX,
								clientY: event.clientY,
							});
							lastDiffLocationRef.current = { ...location, column };
						}}
					>
						<CodeMirrorDiffViewer
							original={diffData.original}
							modified={diffData.modified}
							language={diffData.language}
							worktreePath={worktreePath}
							viewMode={diffViewMode}
							onChange={onContentChange}
							onSave={onSaveFile}
							blameEntries={blameData?.entries}
							diagnostics={fileDiagnostics}
						/>
					</div>
				</div>
			</DiffViewerContextMenu>
		);
	}

	if (viewMode === "rendered" && isHtml) {
		if (isLoadingRaw) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					Loading...
				</div>
			);
		}

		if (!rawFileData?.ok) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					Cannot preview this file
				</div>
			);
		}

		return (
			<HtmlPreviewWebview key={filePath} absolutePath={absoluteFilePath} />
		);
	}

	if (viewMode === "rendered" && isPdf) {
		return (
			<PdfPreviewWebview key={filePath} absolutePath={absoluteFilePath} />
		);
	}

	if (viewMode === "rendered" && isImage) {
		if (isLoadingImage) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					<LuLoader className="mr-2 h-4 w-4 animate-spin" />
					<span>Loading image...</span>
				</div>
			);
		}

		if (!imageData?.ok) {
			const errorMessage =
				imageData?.reason === "too-large"
					? "Image is too large to preview (max 10MB)"
					: imageData?.reason === "not-image"
						? "Not a supported image format"
						: imageData?.reason === "is-directory"
							? "This path is a directory"
							: "Image not found";

			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					{errorMessage}
				</div>
			);
		}

		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-[#0d0d0d] p-4">
				<img
					src={imageData.dataUrl}
					alt={filePath.split("/").pop() || "Image"}
					className="max-h-full max-w-full object-contain"
					style={{ imageRendering: "auto" }}
				/>
			</div>
		);
	}

	if (isLoadingRaw) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				Loading...
			</div>
		);
	}

	if (
		rawFileData?.ok === false &&
		rawFileData.reason === "binary" &&
		isSpreadsheetFile(filePath) &&
		workspaceId
	) {
		return (
			<SpreadsheetViewer
				workspaceId={workspaceId}
				filePath={filePath}
				absoluteFilePath={absoluteFilePath}
			/>
		);
	}

	if (!rawFileData?.ok) {
		const errorMessage =
			rawFileData?.reason === "too-large"
				? "File is too large to preview"
				: rawFileData?.reason === "binary"
					? "Binary file preview not supported"
					: rawFileData?.reason === "is-directory"
						? "This path is a directory"
						: "File not found";

		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				{errorMessage}
			</div>
		);
	}

	if (viewMode === "rendered") {
		return (
			<div className="relative h-full">
				<MarkdownSearch
					isOpen={markdownSearch.isSearchOpen}
					query={markdownSearch.query}
					caseSensitive={markdownSearch.caseSensitive}
					matchCount={markdownSearch.matchCount}
					activeMatchIndex={markdownSearch.activeMatchIndex}
					onQueryChange={markdownSearch.setQuery}
					onCaseSensitiveChange={markdownSearch.setCaseSensitive}
					onFindNext={markdownSearch.findNext}
					onFindPrevious={markdownSearch.findPrevious}
					onClose={markdownSearch.closeSearch}
				/>
				<div ref={markdownContainerRef} className="h-full overflow-auto p-4">
					<TipTapMarkdownRenderer
						value={renderedContent}
						editable
						editorRef={markdownEditorRef}
						onChange={onContentChange}
						onSave={onSaveFile}
					/>
				</div>
			</div>
		);
	}

	return (
		<FileEditorContextMenu
			editorRef={editorRef}
			filePath={filePath}
			branch={workspace?.branch}
			worktreePath={worktreePath}
			supersetLinkProject={supersetLinkProject}
			onSplitHorizontal={onSplitHorizontal}
			onSplitVertical={onSplitVertical}
			onSplitWithNewChat={onSplitWithNewChat}
			onSplitWithNewBrowser={onSplitWithNewBrowser}
			onEqualizePaneSplits={onEqualizePaneSplits}
			onClosePane={onClosePane}
			currentTabId={currentTabId}
			availableTabs={availableTabs}
			onMoveToTab={onMoveToTab}
			onMoveToNewTab={onMoveToNewTab}
		>
			<div className="h-full w-full">
				<CodeEditor
					key={filePath}
					language={detectLanguage(filePath)}
					worktreePath={worktreePath}
					value={renderedContent}
					onChange={onContentChange}
					onSave={onSaveFile}
					editorRef={editorRef}
					fillHeight
					blameEntries={blameData?.entries}
					diagnostics={fileDiagnostics}
				/>
			</div>
		</FileEditorContextMenu>
	);
}
