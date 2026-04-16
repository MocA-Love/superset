import { CommandItem } from "@superset/ui/command";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";

interface FileResultItemProps {
	value: string;
	fileName: string;
	relativePath: string;
	onSelect: () => void;
}

export function FileResultItem({
	value,
	fileName,
	relativePath,
	onSelect,
}: FileResultItemProps) {
	return (
		<CommandItem
			value={value}
			onSelect={onSelect}
			className="group rounded-sm py-2"
		>
			<FileIcon fileName={fileName} className="size-3.5 shrink-0" />
			<span className="max-w-[252px] truncate font-medium">{fileName}</span>
			<span className="truncate text-muted-foreground text-xs">
				{relativePath}
			</span>
			<kbd className="ml-auto hidden shrink-0 text-xs text-muted-foreground group-data-[selected=true]:block">
				↵
			</kbd>
		</CommandItem>
	);
}
