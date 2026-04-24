import { toast } from "@superset/ui/sonner";
import { useCallback, useRef, useState } from "react";
import type { DestroyWorkspaceSuccess } from "renderer/hooks/host-service/useDestroyWorkspace";
import {
	type DestroyWorkspaceError,
	useDestroyWorkspace,
} from "renderer/hooks/host-service/useDestroyWorkspace";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useDeletingWorkspaces } from "renderer/routes/_authenticated/providers/DeletingWorkspacesProvider";

const STATUS_STALE_TIME_MS = 5_000;

interface UseDestroyDialogStateOptions {
	workspaceId: string;
	workspaceName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted?: () => void;
}

/**
 * Drives the delete flow for `DashboardSidebarDeleteDialog`.
 *
 * UX pattern:
 *   - On confirm, close the dialog immediately, mark the workspace as
 *     deleting (sidebar row hides optimistically), and run destroy in
 *     the background silently. No loading toast — destroy can take
 *     10–20s and a persistent toast across that window feels bad. The
 *     hidden row is the feedback.
 *   - On success, `onDeleted` removes the row from sidebar state.
 *   - On error, `clearDeleting` runs in the `finally` block so the row
 *     reappears. For decision-required errors (TEARDOWN_FAILED)
 *     we reopen the dialog in the matching error pane so the user can
 *     force-retry with full context. The branch opt-in is preserved.
 *   - For unknown errors we just toast.error — no reopen.
 */
export function useDestroyDialogState({
	workspaceId,
	workspaceName,
	open,
	onOpenChange,
	onDeleted,
}: UseDestroyDialogStateOptions) {
	const { destroy } = useDestroyWorkspace(workspaceId);
	const { markDeleting, clearDeleting } = useDeletingWorkspaces();

	const [deleteBranch, setDeleteBranch] = useState(false);

	const { data: canDeleteData, isPending: isCheckingStatus } =
		electronTrpc.workspaces.canDelete.useQuery(
			{ id: workspaceId },
			{
				enabled: open,
				staleTime: STATUS_STALE_TIME_MS,
				refetchOnWindowFocus: false,
			},
		);
	const hasChanges = canDeleteData?.hasChanges ?? false;
	const hasUnpushedCommits = canDeleteData?.hasUnpushedCommits ?? false;

	const [error, setError] = useState<DestroyWorkspaceError | null>(null);
	const inFlight = useRef(false);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) {
				setDeleteBranch(false);
				setError(null);
			}
			onOpenChange(next);
		},
		[onOpenChange],
	);

	const run = useCallback(
		async (force: boolean) => {
			if (inFlight.current) return;
			inFlight.current = true;

			// Optimistic close. State (deleteBranch) preserved in case we re-open
			// on a decision-required error.
			setError(null);
			onOpenChange(false);
			markDeleting(workspaceId);

			try {
				let result: DestroyWorkspaceSuccess;
				try {
					result = await destroy({ deleteBranch, force });
				} catch (firstErr) {
					const e = firstErr as DestroyWorkspaceError;
					// Race: preflight said clean but worktree was dirty by the time
					// destroy ran. The user already confirmed once — don't make them
					// confirm a second "uncommitted changes" warning, just force.
					if (e.kind === "conflict" && !force) {
						result = await destroy({ deleteBranch, force: true });
					} else {
						throw firstErr;
					}
				}
				for (const warning of result.warnings) toast.warning(warning);
				setDeleteBranch(false);
				onDeleted?.();
			} catch (err) {
				const e = err as DestroyWorkspaceError;
				if (e.kind === "teardown-failed") {
					setError(e);
					onOpenChange(true);
				} else {
					toast.error(`Failed to delete ${workspaceName}: ${e.message}`);
				}
			} finally {
				clearDeleting(workspaceId);
				inFlight.current = false;
			}
		},
		[
			destroy,
			deleteBranch,
			workspaceName,
			workspaceId,
			onOpenChange,
			onDeleted,
			markDeleting,
			clearDeleting,
		],
	);

	return {
		deleteBranch,
		setDeleteBranch,
		hasChanges,
		hasUnpushedCommits,
		isCheckingStatus,
		error,
		handleOpenChange,
		run,
	};
}
