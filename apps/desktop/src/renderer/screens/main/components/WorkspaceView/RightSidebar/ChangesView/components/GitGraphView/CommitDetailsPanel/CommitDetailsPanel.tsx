import type { ReactNode } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { ChangedFile, CommitGraphNode } from "shared/changes-types";

interface CommitDetailsPanelProps {
	node: CommitGraphNode;
	worktreePath: string;
	workspaceId: string;
	onParentSelect: (hash: string) => void;
	visibleCommitHashes: Set<string>;
	containerWidth: number;
}

const FILE_STATUS_LABELS: Record<ChangedFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	untracked: "?",
};

function formatCommitDate(date: Date): string {
	return new Date(date).toLocaleString(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatPerson(name: string, email: string): string {
	return email ? `${name} <${email}>` : name;
}

function getStatusColor(status: ChangedFile["status"]): string {
	switch (status) {
		case "added":
		case "copied":
		case "untracked":
			return "text-emerald-500";
		case "deleted":
			return "text-red-500";
		case "renamed":
			return "text-sky-500";
		default:
			return "text-amber-500";
	}
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
			<span className="text-muted-foreground">{label}</span>
			<div className="min-w-0 break-words">{value}</div>
		</div>
	);
}

export function CommitDetailsPanel({
	node,
	worktreePath,
	workspaceId,
	onParentSelect,
	visibleCommitHashes,
	containerWidth,
}: CommitDetailsPanelProps) {
	const { copyToClipboard, copied } = useCopyToClipboard(1200);
	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const {
		data: files,
		isLoading,
		isError,
	} = electronTrpc.changes.getCommitFiles.useQuery(
		{
			worktreePath,
			commitHash: node.hash,
		},
		{ staleTime: 30_000 },
	);
	const message = node.fullMessage.trimEnd() || node.message || "(no message)";

	return (
		<div className="border-t border-border/50 bg-muted/20 px-3 py-3 text-xs">
			<div
				className={
					containerWidth >= 900
						? "grid gap-4 grid-cols-[minmax(0,1fr)_280px]"
						: "flex flex-col gap-4"
				}
			>
				<div className="space-y-3">
					<div className="space-y-2">
						<MetadataRow
							label="Commit"
							value={
								<button
									type="button"
									onClick={() => {
										void copyToClipboard(node.hash);
									}}
									className="font-mono text-left text-[11px] text-primary underline underline-offset-4 transition-opacity hover:opacity-80"
									title={copied ? "Copied" : "Copy commit hash"}
								>
									{node.hash}
								</button>
							}
						/>

						<MetadataRow
							label="Parents"
							value={
								node.parentHashes.length > 0 ? (
									<div className="flex flex-wrap gap-x-3 gap-y-1">
										{node.parentHashes.map((parentHash) => {
											const canNavigate = visibleCommitHashes.has(parentHash);
											return (
												<button
													key={parentHash}
													type="button"
													onClick={() => {
														if (canNavigate) {
															onParentSelect(parentHash);
														}
													}}
													disabled={!canNavigate}
													className="font-mono text-left text-[11px] text-primary underline underline-offset-4 disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
													title={
														canNavigate
															? "Jump to commit"
															: "Commit is outside the current graph range"
													}
												>
													{parentHash}
												</button>
											);
										})}
									</div>
								) : (
									<span className="text-muted-foreground">-</span>
								)
							}
						/>

						<MetadataRow
							label="Author"
							value={
								<span className="font-mono text-[11px]">
									{formatPerson(node.author, node.authorEmail)}
								</span>
							}
						/>

						<MetadataRow
							label="Committer"
							value={
								<span className="font-mono text-[11px]">
									{formatPerson(node.committer, node.committerEmail)}
								</span>
							}
						/>

						<MetadataRow
							label="Date"
							value={
								<span className="font-mono text-[11px]">
									{formatCommitDate(node.date)}
								</span>
							}
						/>
					</div>

					<div className="space-y-1">
						<div className="text-muted-foreground">Message</div>
						<div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-words">
							{message}
						</div>
					</div>
				</div>

				<div className="space-y-2">
					<div className="text-muted-foreground">Files</div>
					<div className="rounded-md border border-border/60 bg-background/70">
						{isLoading && (
							<div className="px-3 py-2 text-muted-foreground">
								Loading files...
							</div>
						)}

						{isError && (
							<div className="px-3 py-2 text-destructive">
								Failed to load files
							</div>
						)}

						{!isLoading && !isError && (files?.length ?? 0) === 0 && (
							<div className="px-3 py-2 text-muted-foreground">
								No file changes
							</div>
						)}

						{files?.map((file) => (
							<button
								key={`${node.hash}:${file.path}`}
								type="button"
								onClick={() => {
									const absolutePath = toAbsoluteWorkspacePath(
										worktreePath,
										file.path,
									);
									const absoluteOldPath =
										file.status === "renamed" &&
										"oldPath" in file &&
										typeof file.oldPath === "string"
											? toAbsoluteWorkspacePath(worktreePath, file.oldPath)
											: undefined;
									addFileViewerPane(workspaceId, {
										filePath: absolutePath,
										diffCategory: "committed",
										fileStatus: file.status,
										commitHash: node.hash,
										oldPath: absoluteOldPath,
										openInNewTab: false,
										useRightSidebarOpenViewWidth: true,
									});
								}}
								className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/50 first:border-t-0"
							>
								<span
									className={`font-mono text-[11px] ${getStatusColor(file.status)}`}
									title={file.status}
								>
									{FILE_STATUS_LABELS[file.status]}
								</span>
								<span
									className="truncate font-mono text-[11px]"
									title={file.path}
								>
									{file.path}
								</span>
								<span className="font-mono text-[11px] text-muted-foreground">
									<span className="text-emerald-500">+{file.additions}</span>{" "}
									<span className="text-red-500">-{file.deletions}</span>
								</span>
							</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
