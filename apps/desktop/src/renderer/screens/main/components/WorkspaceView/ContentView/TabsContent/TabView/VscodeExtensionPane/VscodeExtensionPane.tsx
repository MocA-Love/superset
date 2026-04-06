import { VscodeExtensionView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/VscodeExtensionView";

interface VscodeExtensionPaneProps {
	paneId: string;
	viewType: string;
	extensionId: string;
}

export function VscodeExtensionPane({
	paneId,
	viewType,
	extensionId,
}: VscodeExtensionPaneProps) {
	return (
		<div className="h-full w-full flex flex-col">
			<VscodeExtensionView
				viewType={viewType}
				extensionId={extensionId}
				isActive={true}
			/>
		</div>
	);
}
