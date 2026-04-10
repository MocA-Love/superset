import type { RendererContext } from "@superset/panes";
import { useCallback } from "react";
// FORK NOTE: useFileDocument import path changed from @superset/workspace-client
// to renderer/hooks/host-service/useFileDocument (upstream #3224)
import { useFileDocument } from "renderer/hooks/host-service/useFileDocument";
import {
	deriveMemoDisplayName,
	getTrustedMemoRootPath,
} from "renderer/lib/workspace-memos";
import { SpreadsheetViewer } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/FileViewerPane/components/SpreadsheetViewer";
import {
	isImageFile,
	isMarkdownFile,
	isSpreadsheetFile,
} from "shared/file-types";
import type { FilePaneData, PaneViewerData } from "../../../../types";
import { CodeRenderer } from "./renderers/CodeRenderer";
import { ImageRenderer } from "./renderers/ImageRenderer";
import { MarkdownRenderer } from "./renderers/MarkdownRenderer";

interface FilePaneProps {
	context: RendererContext<PaneViewerData>;
	workspaceId: string;
}

export function FilePane({ context, workspaceId }: FilePaneProps) {
	const data = context.pane.data as FilePaneData;
	const { filePath } = data;

	// Spreadsheet files bypass useFileDocument entirely (own data loading)
	if (isSpreadsheetFile(filePath)) {
		return (
			<SpreadsheetViewer
				workspaceId={workspaceId}
				filePath={filePath}
				absoluteFilePath={filePath}
			/>
		);
	}

	return <FilePaneContent context={context} workspaceId={workspaceId} />;
}

function FilePaneContent({ context, workspaceId }: FilePaneProps) {
	const data = context.pane.data as FilePaneData;
	const { filePath } = data;
	const isMemoFile = Boolean(getTrustedMemoRootPath(filePath));

	const document = useFileDocument({
		workspaceId,
		absolutePath: filePath,
		mode: isImageFile(filePath) ? "bytes" : "auto",
		maxBytes: isImageFile(filePath) ? 10 * 1024 * 1024 : 2 * 1024 * 1024,
		hasLocalChanges: data.hasChanges,
		autoReloadWhenClean: true,
	});

	const handleDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty !== data.hasChanges) {
				context.actions.updateData({
					...data,
					hasChanges: dirty,
				} as PaneViewerData);
			}
		},
		[context.actions, data],
	);

	const handleSave = useCallback(
		async (content: string) => {
			const result = await document.save({ content });
			if (result.status === "saved") {
				handleDirtyChange(false);
			}
			return result;
		},
		[document, handleDirtyChange],
	);

	const handleDisplayNameChange = useCallback(
		(displayName: string) => {
			if (!isMemoFile || data.displayName === displayName) {
				return;
			}

			context.actions.updateData({
				...data,
				displayName,
			} as PaneViewerData);
		},
		[context.actions, data, isMemoFile],
	);

	if (document.state.kind === "loading") {
		return null;
	}

	if (document.state.kind === "not-found") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				File not found
			</div>
		);
	}

	if (document.state.kind === "too-large") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				File is too large to display
			</div>
		);
	}

	if (document.state.kind === "binary" || document.state.kind === "bytes") {
		if (isImageFile(filePath) && document.state.kind === "bytes") {
			return (
				<ImageRenderer content={document.state.content} filePath={filePath} />
			);
		}
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Binary file — cannot display
			</div>
		);
	}

	if (isMarkdownFile(filePath)) {
		const displayName = isMemoFile
			? (data.displayName ?? deriveMemoDisplayName(document.state.content))
			: data.displayName;
		return (
			<MarkdownRenderer
				content={document.state.content}
				displayName={displayName}
				filePath={filePath}
				hasExternalChange={document.hasExternalChange}
				isMemo={isMemoFile}
				onDirtyChange={handleDirtyChange}
				onDisplayNameChange={handleDisplayNameChange}
				onReload={document.reload}
				onSave={handleSave}
				workspaceId={workspaceId}
			/>
		);
	}

	return (
		<CodeRenderer
			content={document.state.content}
			filePath={filePath}
			hasExternalChange={document.hasExternalChange}
			onDirtyChange={handleDirtyChange}
			onReload={document.reload}
			onSave={handleSave}
		/>
	);
}
