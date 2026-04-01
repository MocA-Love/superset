import type { ExternalApp } from "@superset/local-db";
import type { ChangeCategory, ChangedFile } from "shared/changes-types";
import { FileItem } from "../FileItem";
import { getDirectoryLabel, sortFilesForCompactView } from "./compact-view";

interface FileListCompactProps {
	files: ChangedFile[];
	selectedFile: ChangedFile | null;
	selectedCommitHash: string | null;
	onFileSelect: (file: ChangedFile) => void;
	showStats?: boolean;
	onStage?: (file: ChangedFile) => void;
	onUnstage?: (file: ChangedFile) => void;
	isActioning?: boolean;
	worktreePath: string;
	onDiscard?: (file: ChangedFile) => void;
	category?: ChangeCategory;
	commitHash?: string;
	isExpandedView?: boolean;
	projectId?: string;
	defaultApp?: ExternalApp | null;
}

export function FileListCompact({
	files,
	selectedFile,
	selectedCommitHash,
	onFileSelect,
	showStats = true,
	onStage,
	onUnstage,
	isActioning,
	worktreePath,
	onDiscard,
	category,
	commitHash,
	isExpandedView,
	projectId,
	defaultApp,
}: FileListCompactProps) {
	const sortedFiles = sortFilesForCompactView(files);

	return (
		<div className="flex flex-col overflow-hidden">
			{sortedFiles.map((file) => (
				<FileItem
					key={file.path}
					file={file}
					isSelected={
						selectedFile?.path === file.path &&
						(!commitHash || selectedCommitHash === commitHash)
					}
					onClick={() => onFileSelect(file)}
					showStats={showStats}
					directoryLabel={getDirectoryLabel(file.path)}
					onStage={onStage ? () => onStage(file) : undefined}
					onUnstage={onUnstage ? () => onUnstage(file) : undefined}
					isActioning={isActioning}
					worktreePath={worktreePath}
					projectId={projectId}
					defaultApp={defaultApp}
					onDiscard={onDiscard ? () => onDiscard(file) : undefined}
					category={category}
					commitHash={commitHash}
					isExpandedView={isExpandedView}
				/>
			))}
		</div>
	);
}
