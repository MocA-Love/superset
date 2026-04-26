import { useNavigate } from "@tanstack/react-router";
import { useDiffStats } from "renderer/hooks/host-service/useDiffStats";
import { useV2WorkspaceNotificationStatus } from "renderer/stores/v2-notifications";
import type { DashboardSidebarWorkspace } from "../../types";
import { DashboardSidebarDeleteDialog } from "../DashboardSidebarDeleteDialog";
import { DashboardSidebarCollapsedWorkspaceButton } from "./components/DashboardSidebarCollapsedWorkspaceButton";
import { DashboardSidebarExpandedWorkspaceRow } from "./components/DashboardSidebarExpandedWorkspaceRow";
import { DashboardSidebarWorkspaceContextMenu } from "./components/DashboardSidebarWorkspaceContextMenu/DashboardSidebarWorkspaceContextMenu";
import { DashboardSidebarWorkspaceHoverCardContent } from "./components/DashboardSidebarWorkspaceHoverCardContent";
import { useDashboardSidebarWorkspaceItemActions } from "./hooks/useDashboardSidebarWorkspaceItemActions";

interface DashboardSidebarWorkspaceItemProps {
	workspace: DashboardSidebarWorkspace;
	onHoverCardOpen?: () => void;
	shortcutLabel?: string;
	isCollapsed?: boolean;
	isInSection?: boolean;
}

export function DashboardSidebarWorkspaceItem({
	workspace,
	onHoverCardOpen,
	shortcutLabel,
	isCollapsed = false,
	isInSection = false,
}: DashboardSidebarWorkspaceItemProps) {
	const {
		id,
		projectId,
		accentColor = null,
		hostType,
		hostIsOnline,
		name,
		branch,
		creationStatus,
	} = workspace;
	const diffStats = useDiffStats(id);
	const workspaceStatus = useV2WorkspaceNotificationStatus(id);
	const {
		cancelRename,
		handleClick,
		handleCopyBranchName,
		handleCopyPath,
		handleCreateSection,
		handleDeleted,
		handleOpenInFinder,
<<<<<<< HEAD
=======
		handleRemoveFromSidebar,
		handleToggleUnread,
>>>>>>> 6ada9bf8d (Add v2 mark workspace as unread (#3773))
		isActive,
		isDeleteDialogOpen,
		isUnread,
		isRenaming,
		moveWorkspaceToSection,
		removeWorkspaceFromSidebar,
		renameValue,
		setIsDeleteDialogOpen,
		setRenameValue,
		startRename,
		submitRename,
	} = useDashboardSidebarWorkspaceItemActions({
		workspaceId: id,
		projectId,
		workspaceName: name,
		branch,
	});

	const navigate = useNavigate();
	const isPending = !!creationStatus;
	const handlePendingClick = isPending
		? () => {
				void navigate({
					to: `/pending/${id}` as string,
				});
			}
		: undefined;

	if (isCollapsed) {
		const content = (
			<div className="relative flex w-full justify-center">
				{(accentColor || isActive) && (
					<div
						className="absolute inset-y-0 left-0 w-0.5"
						style={{
							backgroundColor: accentColor ?? "var(--color-foreground)",
						}}
					/>
				)}
				<DashboardSidebarCollapsedWorkspaceButton
					hostType={hostType}
					hostIsOnline={hostIsOnline}
					isActive={isActive}
					workspaceStatus={workspaceStatus}
					onClick={isPending ? handlePendingClick : handleClick}
					creationStatus={creationStatus}
					disabled={isPending}
					aria-label={
						creationStatus ? `Creating workspace: ${name}` : undefined
					}
				/>
			</div>
		);

		return (
			<>
<<<<<<< HEAD
				{isPending ? (
					content
				) : (
					<DashboardSidebarWorkspaceContextMenu
						projectId={projectId}
						isInSection={isInSection}
						onHoverCardOpen={
							hostType === "local-device" ? onHoverCardOpen : undefined
						}
						hoverCardContent={
							<DashboardSidebarWorkspaceHoverCardContent
								workspace={workspace}
								diffStats={diffStats}
							/>
						}
						isLocalWorkspace={hostType === "local-device"}
						onCreateSection={handleCreateSection}
						onMoveToSection={(targetSectionId) =>
							moveWorkspaceToSection(id, projectId, targetSectionId)
						}
						onOpenInFinder={handleOpenInFinder}
						onCopyPath={handleCopyPath}
						onCopyBranchName={handleCopyBranchName}
						onRemoveFromSidebar={() => removeWorkspaceFromSidebar(id)}
						onRename={startRename}
						onDelete={() => setIsDeleteDialogOpen(true)}
					>
						{content}
					</DashboardSidebarWorkspaceContextMenu>
				)}
=======
				<div hidden={isDeleting}>
					{isPending ? (
						content
					) : (
						<DashboardSidebarWorkspaceContextMenu
							projectId={projectId}
							isInSection={isInSection}
							isUnread={isUnread}
							onHoverCardOpen={
								hostType === "local-device" ? onHoverCardOpen : undefined
							}
							hoverCardContent={
								<DashboardSidebarWorkspaceHoverCardContent
									workspace={workspace}
									diffStats={diffStats}
								/>
							}
							isLocalWorkspace={hostType === "local-device"}
							onCreateSection={handleCreateSection}
							onMoveToSection={(targetSectionId) =>
								moveWorkspaceToSection(id, projectId, targetSectionId)
							}
							onOpenInFinder={handleOpenInFinder}
							onCopyPath={handleCopyPath}
							onCopyBranchName={handleCopyBranchName}
							onRemoveFromSidebar={handleRemoveFromSidebar}
							onRename={startRename}
							onDelete={() => setIsDeleteDialogOpen(true)}
							onToggleUnread={handleToggleUnread}
						>
							{content}
						</DashboardSidebarWorkspaceContextMenu>
					)}
				</div>
>>>>>>> 6ada9bf8d (Add v2 mark workspace as unread (#3773))

				{!isPending && (
					<DashboardSidebarDeleteDialog
						workspaceId={id}
						workspaceName={name || branch}
						open={isDeleteDialogOpen}
						onOpenChange={setIsDeleteDialogOpen}
						onDeleted={handleDeleted}
					/>
				)}
			</>
		);
	}

	const expandedContent = (
		<DashboardSidebarExpandedWorkspaceRow
			workspace={workspace}
			isActive={isActive}
			isRenaming={isRenaming}
			renameValue={renameValue}
			shortcutLabel={shortcutLabel}
			diffStats={isPending ? null : diffStats}
			workspaceStatus={workspaceStatus}
			onClick={isPending ? handlePendingClick : handleClick}
			onDoubleClick={isPending ? undefined : startRename}
			onDeleteClick={() => setIsDeleteDialogOpen(true)}
			onRenameValueChange={setRenameValue}
			onSubmitRename={submitRename}
			onCancelRename={cancelRename}
		/>
	);

	return (
		<>
<<<<<<< HEAD
			{isPending ? (
				expandedContent
			) : (
				<DashboardSidebarWorkspaceContextMenu
					projectId={projectId}
					isInSection={isInSection}
					onHoverCardOpen={
						hostType === "local-device" ? onHoverCardOpen : undefined
					}
					hoverCardContent={
						<DashboardSidebarWorkspaceHoverCardContent
							workspace={workspace}
							diffStats={diffStats}
						/>
					}
					onCreateSection={handleCreateSection}
					onMoveToSection={(targetSectionId) =>
						moveWorkspaceToSection(id, projectId, targetSectionId)
					}
					isLocalWorkspace={hostType === "local-device"}
					onOpenInFinder={handleOpenInFinder}
					onCopyPath={handleCopyPath}
					onCopyBranchName={handleCopyBranchName}
					onRemoveFromSidebar={() => removeWorkspaceFromSidebar(id)}
					onRename={startRename}
					onDelete={() => setIsDeleteDialogOpen(true)}
				>
					{expandedContent}
				</DashboardSidebarWorkspaceContextMenu>
			)}
=======
			<div hidden={isDeleting}>
				{isPending ? (
					expandedContent
				) : (
					<DashboardSidebarWorkspaceContextMenu
						projectId={projectId}
						isInSection={isInSection}
						isUnread={isUnread}
						onHoverCardOpen={
							hostType === "local-device" ? onHoverCardOpen : undefined
						}
						hoverCardContent={
							<DashboardSidebarWorkspaceHoverCardContent
								workspace={workspace}
								diffStats={diffStats}
							/>
						}
						onCreateSection={handleCreateSection}
						onMoveToSection={(targetSectionId) =>
							moveWorkspaceToSection(id, projectId, targetSectionId)
						}
						isLocalWorkspace={hostType === "local-device"}
						onOpenInFinder={handleOpenInFinder}
						onCopyPath={handleCopyPath}
						onCopyBranchName={handleCopyBranchName}
						onRemoveFromSidebar={handleRemoveFromSidebar}
						onRename={startRename}
						onDelete={() => setIsDeleteDialogOpen(true)}
						onToggleUnread={handleToggleUnread}
					>
						{expandedContent}
					</DashboardSidebarWorkspaceContextMenu>
				)}
			</div>
>>>>>>> 6ada9bf8d (Add v2 mark workspace as unread (#3773))

			{!isPending && (
				<DashboardSidebarDeleteDialog
					workspaceId={id}
					workspaceName={name || branch}
					open={isDeleteDialogOpen}
					onOpenChange={setIsDeleteDialogOpen}
					onDeleted={handleDeleted}
				/>
			)}
		</>
	);
}
