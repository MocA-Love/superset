import type { RendererContext } from "@superset/panes";
import { useCallback } from "react";
import { isSpreadsheetFile } from "shared/file-types";
import { useSharedFileDocument } from "../../../../../../state/fileDocumentStore";
import type { FilePaneData, PaneViewerData } from "../../../../../../types";
import { orderForToggle, resolveActivePaneView } from "../../registry";
import { FileViewToggle } from "../FileViewToggle";

interface FilePaneHeaderExtrasProps {
	context: RendererContext<PaneViewerData>;
	workspaceId: string;
}

export function FilePaneHeaderExtras({
	context,
	workspaceId,
}: FilePaneHeaderExtrasProps) {
	const data = context.pane.data as FilePaneData;
	const { filePath } = data;

	// FORK NOTE: Spreadsheet files bypass the shared document store in
	// FilePane, so the view-toggle has no views to switch between; skip it
	// before the hook tries to acquire a document that will never load.
	if (isSpreadsheetFile(filePath)) {
		return null;
	}

	return (
		<FilePaneHeaderExtrasInner
			context={context}
			workspaceId={workspaceId}
			filePath={filePath}
			data={data}
		/>
	);
}

function FilePaneHeaderExtrasInner({
	context,
	workspaceId,
	filePath,
	data,
}: FilePaneHeaderExtrasProps & {
	filePath: string;
	data: FilePaneData;
}) {
	const document = useSharedFileDocument({
		workspaceId,
		absolutePath: filePath,
	});

	const handleChangeView = useCallback(
		(viewId: string) => {
			context.actions.updateData({
				...data,
				viewId,
			} as PaneViewerData);
		},
		[context.actions, data],
	);

	const { views, activeView } = resolveActivePaneView(document, data);

	if (views.length <= 1 || data.forceViewId) return null;
	if (!activeView) return null;

	return (
		<FileViewToggle
			views={orderForToggle(views)}
			activeViewId={activeView.id}
			filePath={filePath}
			onChange={handleChangeView}
		/>
	);
}
