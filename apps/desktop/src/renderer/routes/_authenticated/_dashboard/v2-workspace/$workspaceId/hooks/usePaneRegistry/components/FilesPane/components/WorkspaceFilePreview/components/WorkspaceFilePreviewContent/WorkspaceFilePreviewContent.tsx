import { SpreadsheetViewer } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/FileViewerPane/components/SpreadsheetViewer";
import { isSpreadsheetFile } from "shared/file-types";
import { useSharedFileDocument } from "../../../../../../../../state/fileDocumentStore";

interface WorkspaceFilePreviewContentProps {
	selectedFilePath: string;
	workspaceId: string;
}

export function WorkspaceFilePreviewContent({
	selectedFilePath,
	workspaceId,
}: WorkspaceFilePreviewContentProps) {
	// FORK NOTE: Fork-only sidebar file preview. Upstream removed its own
	// equivalent in c504; ported to the new shared document store so we can
	// keep the fork feature while the rest of v2 migrates off the old
	// useFileDocument hook.
	const document = useSharedFileDocument({
		workspaceId,
		absolutePath: selectedFilePath,
	});

	if (document.content.kind === "loading") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Loading file...
			</div>
		);
	}

	if (document.content.kind === "not-found") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				File not found
			</div>
		);
	}

	if (document.content.kind === "is-directory") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Directory previews are not implemented yet
			</div>
		);
	}

	if (document.content.kind === "too-large") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				File is too large to preview
			</div>
		);
	}

	if (document.content.kind === "error") {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				{document.content.error.message}
			</div>
		);
	}

	if (document.content.kind === "bytes") {
		if (isSpreadsheetFile(selectedFilePath)) {
			return (
				<SpreadsheetViewer
					workspaceId={workspaceId}
					filePath={selectedFilePath}
					absoluteFilePath={selectedFilePath}
				/>
			);
		}
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Binary files are not previewed yet
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-center justify-between gap-4">
					<div className="min-w-0">
						<h2 className="truncate text-sm font-medium">
							{document.absolutePath}
						</h2>
						<p className="text-xs text-muted-foreground">
							Revision {document.content.revision}
						</p>
					</div>
					<button
						className="text-xs text-muted-foreground transition hover:text-foreground"
						onClick={() => void document.reload()}
						type="button"
					>
						Reload
					</button>
				</div>
				{document.hasExternalChange ? (
					<p className="mt-2 text-xs text-amber-600">
						File changed on disk. Reload to sync with the workspace.
					</p>
				) : null}
			</div>
			<pre className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4 text-xs leading-6 text-foreground">
				{document.content.value}
			</pre>
		</div>
	);
}
