import { toast } from "@superset/ui/sonner";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useCleanupMissingWorktrees } from "renderer/react-query/workspaces/useCleanupMissingWorktrees";

const POLL_MS = 30_000;

/**
 * Background sync for externally-deleted worktrees.
 *
 * Renders nothing. When the project has `autoRemoveMissingWorktrees` enabled
 * and the server reports tracked worktrees whose paths no longer exist on
 * disk, trigger the cleanup mutation so the sidebar reflects reality.
 */
export function ProjectWorktreeAutoSync({ projectId }: { projectId: string }) {
	const { data: project } = electronTrpc.projects.get.useQuery({
		id: projectId,
	});
	const autoRemoveEnabled = project?.autoRemoveMissingWorktrees === true;

	// Only pay the cost of listing + existsSync-ing tracked worktrees when the
	// project has opted in. Otherwise the query is skipped entirely.
	const { data: missingWorktrees = [], isLoading } =
		electronTrpc.workspaces.githubExtended.getMissingWorktrees.useQuery(
			{ projectId },
			{
				enabled: autoRemoveEnabled,
				refetchInterval: autoRemoveEnabled ? POLL_MS : false,
			},
		);
	const cleanupMutation = useCleanupMissingWorktrees();

	const inFlightRef = useRef(false);

	useEffect(() => {
		if (!autoRemoveEnabled) return;
		if (isLoading) return;
		if (missingWorktrees.length === 0) return;
		if (inFlightRef.current) return;
		if (cleanupMutation.isPending) return;

		inFlightRef.current = true;
		cleanupMutation
			.mutateAsync({ projectId })
			.then((result) => {
				if (result.removed > 0) {
					toast.success(
						`Auto-removed ${result.removed} missing worktree${result.removed === 1 ? "" : "s"}`,
					);
				}
			})
			.catch((err) => {
				toast.error(
					err instanceof Error ? err.message : "Failed to clean up worktrees",
				);
			})
			.finally(() => {
				inFlightRef.current = false;
			});
	}, [
		autoRemoveEnabled,
		isLoading,
		missingWorktrees.length,
		cleanupMutation,
		projectId,
	]);

	return null;
}
