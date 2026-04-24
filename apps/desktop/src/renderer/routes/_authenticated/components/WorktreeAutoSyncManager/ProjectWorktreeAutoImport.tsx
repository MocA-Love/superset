import { toast } from "@superset/ui/sonner";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useImportAllWorktrees } from "renderer/react-query/workspaces/useImportAllWorktrees";

const POLL_MS = 30_000;

/**
 * Background auto-import for externally-created worktrees.
 *
 * Renders nothing. When `autoImportExternalWorktrees` is enabled on the
 * project and the scanner detects git worktrees on disk that are not yet
 * tracked in the DB, trigger the same importAllWorktrees mutation that the
 * manual "Import all" button uses.
 *
 * The scanner query runs on an interval so new worktrees created after mount
 * (e.g. by an external LLM agent) get picked up without requiring a window
 * refocus or route change.
 */
export function ProjectWorktreeAutoImport({
	projectId,
}: {
	projectId: string;
}) {
	const { data: project } = electronTrpc.projects.get.useQuery({
		id: projectId,
	});
	const autoImportEnabled = project?.autoImportExternalWorktrees === true;

	const { data: externalWorktrees = [], isLoading } =
		electronTrpc.workspaces.getExternalWorktrees.useQuery(
			{ projectId },
			{
				enabled: autoImportEnabled,
				refetchInterval: autoImportEnabled ? POLL_MS : false,
			},
		);

	const importAllWorktrees = useImportAllWorktrees();
	const inFlightRef = useRef(false);
	const lastFailedSignatureRef = useRef<string | null>(null);

	const externalSignature = externalWorktrees
		.map((wt) => wt.path)
		.sort()
		.join("\n");

	useEffect(() => {
		if (!autoImportEnabled) return;
		if (isLoading) return;
		if (externalWorktrees.length === 0) return;
		if (inFlightRef.current) return;
		if (importAllWorktrees.isPending) return;
		if (lastFailedSignatureRef.current === externalSignature) return;

		inFlightRef.current = true;
		importAllWorktrees
			.mutateAsync({ projectId })
			.then((result) => {
				lastFailedSignatureRef.current = null;
				if (result.imported > 0) {
					toast.success(
						`Auto-imported ${result.imported} worktree${result.imported === 1 ? "" : "s"}`,
					);
				}
			})
			.catch((err) => {
				lastFailedSignatureRef.current = externalSignature;
				toast.error(
					err instanceof Error ? err.message : "Failed to import worktrees",
				);
			})
			.finally(() => {
				inFlightRef.current = false;
			});
	}, [
		autoImportEnabled,
		isLoading,
		externalWorktrees.length,
		externalSignature,
		importAllWorktrees,
		projectId,
	]);

	return null;
}
