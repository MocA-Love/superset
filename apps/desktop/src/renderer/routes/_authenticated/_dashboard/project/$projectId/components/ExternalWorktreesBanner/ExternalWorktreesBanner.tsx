import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef } from "react";
import { GoGitBranch } from "react-icons/go";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useImportAllWorktrees } from "renderer/react-query/workspaces/useImportAllWorktrees";

const MAX_VISIBLE_BRANCHES = 5;

export function ExternalWorktreesBanner({ projectId }: { projectId: string }) {
	const { data: externalWorktrees = [], isLoading } =
		electronTrpc.workspaces.getExternalWorktrees.useQuery({ projectId });
	const { data: project } = electronTrpc.projects.get.useQuery({
		id: projectId,
	});

	const importAllWorktrees = useImportAllWorktrees();

	const handleImportAll = useCallback(
		async (silent = false): Promise<boolean> => {
			try {
				const result = await importAllWorktrees.mutateAsync({ projectId });
				if (!silent) {
					toast.success(
						`Imported ${result.imported} workspace${result.imported === 1 ? "" : "s"}`,
					);
				} else if (result.imported > 0) {
					toast.success(
						`Auto-imported ${result.imported} worktree${result.imported === 1 ? "" : "s"}`,
					);
				}
				return true;
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : "Failed to import worktrees",
				);
				return false;
			}
		},
		[importAllWorktrees, projectId],
	);

	const autoImportInFlightRef = useRef(false);
	const lastFailedSignatureRef = useRef<string | null>(null);
	const autoImportEnabled = project?.autoImportExternalWorktrees === true;

	// Stable signature of the current external-worktree set. We remember the
	// signature of the last auto-import attempt that failed so we do not
	// retry the same (broken) set on every render — that previously created a
	// tight failure loop of mutations + error toasts with no user action.
	const externalSignature = externalWorktrees
		.map((wt) => wt.path)
		.sort()
		.join("\n");

	useEffect(() => {
		if (!autoImportEnabled) return;
		if (isLoading) return;
		if (externalWorktrees.length === 0) return;
		if (autoImportInFlightRef.current) return;
		if (importAllWorktrees.isPending) return;
		if (lastFailedSignatureRef.current === externalSignature) return;

		autoImportInFlightRef.current = true;
		handleImportAll(true)
			.then((ok) => {
				lastFailedSignatureRef.current = ok ? null : externalSignature;
			})
			.finally(() => {
				autoImportInFlightRef.current = false;
			});
	}, [
		autoImportEnabled,
		isLoading,
		externalWorktrees.length,
		externalSignature,
		importAllWorktrees.isPending,
		handleImportAll,
	]);

	if (isLoading || externalWorktrees.length === 0) {
		return null;
	}

	if (autoImportEnabled) {
		return null;
	}

	const visibleBranches = externalWorktrees.slice(0, MAX_VISIBLE_BRANCHES);
	const remainingCount = externalWorktrees.length - visibleBranches.length;

	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="mx-6 mt-6 rounded-lg border border-border/60 bg-card/50 p-4"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-2 min-w-0">
					<p className="text-sm font-medium text-foreground">
						{externalWorktrees.length} existing worktree
						{externalWorktrees.length === 1 ? "" : "s"} found
					</p>
					<div className="flex flex-wrap gap-1.5">
						{visibleBranches.map((wt) => (
							<span
								key={wt.path}
								className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
							>
								<GoGitBranch className="size-3 shrink-0" />
								<span className="truncate max-w-[180px]">{wt.branch}</span>
							</span>
						))}
						{remainingCount > 0 && (
							<span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								+{remainingCount} more
							</span>
						)}
					</div>
				</div>

				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							size="sm"
							variant="outline"
							className="shrink-0"
							disabled={importAllWorktrees.isPending}
						>
							{importAllWorktrees.isPending ? "Importing..." : "Import all"}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Import all worktrees</AlertDialogTitle>
							<AlertDialogDescription>
								This will import {externalWorktrees.length} existing worktree
								{externalWorktrees.length === 1 ? "" : "s"} into Superset as
								workspaces. Each worktree on disk will be tracked and appear in
								your sidebar. No files will be modified.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => handleImportAll(false)}>
								Import all
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</motion.div>
	);
}
