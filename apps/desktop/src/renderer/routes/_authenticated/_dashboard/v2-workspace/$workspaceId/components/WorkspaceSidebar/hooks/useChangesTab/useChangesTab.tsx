import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { workspaceTrpc } from "@superset/workspace-client";
import { RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useChangeset } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useChangeset";
import { useOpenInExternalEditor } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useOpenInExternalEditor";
import { useSidebarDiffRef } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useSidebarDiffRef";
import { useWorkspaceGitStatus } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/providers/WorkspaceGitStatusProvider";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import type {
	ChangesFilter,
	ChangesViewMode,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal/schema";
import { VerticalResizablePanels } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/VerticalResizablePanels";
import {
	DEFAULT_DIFFS_PANE_PERCENTAGE,
	useChangesStore,
} from "renderer/stores/changes";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { CommentPaneData } from "../../../../types";
import type { SidebarTabDefinition } from "../../types";
import { ChangesTabContent } from "./components/ChangesTabContent";
import { ReviewPanelSection } from "./components/ReviewPanelSection";

export type { ChangesFilter, ChangesViewMode };

interface UseChangesTabParams {
	workspaceId: string;
	/** Absolute path of the file whose diff/preview is currently open. */
	selectedFilePath?: string;
	onSelectFile?: (path: string, openInNewTab?: boolean) => void;
	onOpenFile?: (absolutePath: string, openInNewTab?: boolean) => void;
	onOpenFileAtLine?: (path: string, line?: number) => void;
	onOpenComment?: (comment: CommentPaneData) => void;
	onOpenUrl?: (url: string) => void;
	isActive?: boolean;
}

export function useChangesTab({
	workspaceId,
	selectedFilePath,
	onSelectFile,
	onOpenFile,
	onOpenFileAtLine,
	onOpenComment,
	onOpenUrl,
	isActive = true,
}: UseChangesTabParams): SidebarTabDefinition {
	const status = useWorkspaceGitStatus();
	const collections = useCollections();
	const utils = workspaceTrpc.useUtils();
	const { diffsPanePercentage, setDiffsPanePercentage } = useChangesStore();
	const localState = collections.v2WorkspaceLocalState.get(workspaceId);
	const filter: ChangesFilter = localState?.sidebarState?.changesFilter ?? {
		kind: "all",
	};
	const viewMode: ChangesViewMode =
		localState?.sidebarState?.changesViewMode ?? "folders";

	const baseBranchQuery = workspaceTrpc.git.getBaseBranch.useQuery(
		{ workspaceId },
		{ staleTime: Number.POSITIVE_INFINITY },
	);
	const baseBranch = baseBranchQuery.data?.baseBranch ?? null;

	const ref = useSidebarDiffRef(workspaceId);
	const { files, isLoading } = useChangeset({
		workspaceId,
		ref,
	});

	const workspaceQuery = workspaceTrpc.workspace.get.useQuery({
		id: workspaceId,
	});
	const worktreePath = workspaceQuery.data?.worktreePath;
	const openInExternalEditor = useOpenInExternalEditor(workspaceId);

	const handleOpenInEditor = useCallback(
		(relativePath: string) => {
			if (!worktreePath) return;
			openInExternalEditor(toAbsoluteWorkspacePath(worktreePath, relativePath));
		},
		[worktreePath, openInExternalEditor],
	);

	const setFilter = useCallback(
		(next: ChangesFilter) => {
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.changesFilter = next;
			});
		},
		[collections, workspaceId],
	);

	const setViewMode = useCallback(
		(next: ChangesViewMode) => {
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.changesViewMode = next;
			});
		},
		[collections, workspaceId],
	);

	const setBaseBranchMutation = workspaceTrpc.git.setBaseBranch.useMutation({
		onSuccess: () => {
			void utils.git.getBaseBranch.invalidate({ workspaceId });
			void utils.git.getStatus.invalidate({ workspaceId });
			void utils.git.listCommits.invalidate({ workspaceId });
			void utils.git.getDiff.invalidate({ workspaceId });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update base branch",
			);
		},
	});

	const setBaseBranch = useCallback(
		(branchName: string) => {
			setBaseBranchMutation.mutate({ workspaceId, baseBranch: branchName });
		},
		[setBaseBranchMutation, workspaceId],
	);

	const commits = workspaceTrpc.git.listCommits.useQuery(
		{ workspaceId, baseBranch: baseBranch ?? undefined },
		{ refetchOnWindowFocus: true },
	);

	const { data: branchSortSettings } =
		electronTrpc.settings.getBranchSortOrder.useQuery(undefined, {
			staleTime: 10_000,
		});
	const branches = workspaceTrpc.git.listBranches.useQuery(
		{
			workspaceId,
			sortOrder: branchSortSettings?.sortOrder,
			pinDefault: branchSortSettings?.pinDefault,
		},
		{ refetchInterval: 30_000, refetchOnWindowFocus: true },
	);

	const renameBranchMutation = workspaceTrpc.git.renameBranch.useMutation();

	const handleRenameBranch = useCallback(
		(newName: string) => {
			const currentName = status.data?.currentBranch.name;
			if (!currentName) return;
			toast.promise(
				renameBranchMutation.mutateAsync({
					workspaceId,
					oldName: currentName,
					newName,
				}),
				{
					loading: `Renaming branch to ${newName}...`,
					success: `Branch renamed to ${newName}`,
					error: (err) =>
						err instanceof Error ? err.message : "Failed to rename branch",
				},
			);
		},
		[workspaceId, status.data?.currentBranch.name, renameBranchMutation],
	);

	const canRenameBranch = !status.data?.currentBranch.upstream;

	const totalChanges = files.length;
	const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

	const [isRefreshing, setIsRefreshing] = useState(false);
	const handleRefresh = useCallback(async () => {
		if (isRefreshing) return;
		setIsRefreshing(true);
		try {
			await Promise.all([
				utils.git.getStatus.invalidate({ workspaceId }),
				utils.git.getDiff.invalidate({ workspaceId }),
				utils.git.listCommits.invalidate({ workspaceId }),
				utils.git.listBranches.invalidate({ workspaceId }),
				utils.git.getBaseBranch.invalidate({ workspaceId }),
			]);
		} catch (error) {
			console.warn("Failed to refresh changes tab", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to refresh changes",
			);
		} finally {
			setIsRefreshing(false);
		}
	}, [utils, workspaceId, isRefreshing]);

	const actions = (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					onClick={() => void handleRefresh()}
					disabled={isRefreshing}
				>
					<RefreshCw
						className={cn("size-3.5", isRefreshing && "animate-spin")}
					/>
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">Refresh changes</TooltipContent>
		</Tooltip>
	);

	const content = (
		<VerticalResizablePanels
			topSizePercentage={diffsPanePercentage}
			onTopSizePercentageChange={setDiffsPanePercentage}
			minTopHeight={220}
			minBottomHeight={180}
			defaultTopSizePercentage={DEFAULT_DIFFS_PANE_PERCENTAGE}
			top={
				<ChangesTabContent
					workspaceId={workspaceId}
					status={status}
					commits={commits}
					branches={branches}
					filter={filter}
					viewMode={viewMode}
					baseBranch={baseBranch}
					files={files}
					isLoading={isLoading}
					totalChanges={totalChanges}
					totalAdditions={totalAdditions}
					totalDeletions={totalDeletions}
					worktreePath={worktreePath}
					selectedFilePath={selectedFilePath}
					onSelectFile={onSelectFile}
					onOpenFile={onOpenFile}
					onOpenInEditor={handleOpenInEditor}
					onFilterChange={setFilter}
					onViewModeChange={setViewMode}
					onBaseBranchChange={setBaseBranch}
					onRenameBranch={handleRenameBranch}
					canRenameBranch={canRenameBranch}
				/>
			}
			bottom={
				<ReviewPanelSection
					workspaceId={workspaceId}
					isActive={isActive}
					onOpenFileAtLine={onOpenFileAtLine}
					onOpenComment={onOpenComment}
					onOpenUrl={onOpenUrl}
				/>
			}
		/>
	);

	return {
		id: "changes",
		label: "Changes",
		badge: totalChanges > 0 ? totalChanges : undefined,
		actions,
		content,
	};
}
