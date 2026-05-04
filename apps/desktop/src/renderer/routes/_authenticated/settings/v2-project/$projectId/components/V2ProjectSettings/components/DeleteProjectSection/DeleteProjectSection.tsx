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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";

interface DeleteProjectSectionProps {
	projectId: string;
	projectName: string;
}

export function DeleteProjectSection({
	projectId,
	projectName,
}: DeleteProjectSectionProps) {
	const navigate = useNavigate();
	const [isDeleting, setIsDeleting] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await apiTrpcClient.v2Project.delete.mutate({ id: projectId });
			toast.success(`Deleted "${projectName}"`);
			setIsOpen(false);
			navigate({ to: "/settings/projects" });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="flex items-center justify-between gap-8">
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">Delete project</div>
				<p className="text-xs text-muted-foreground mt-0.5">
					Removes the project from the organization. Workspaces and local clones
					on any host are not affected.
				</p>
			</div>
			<AlertDialog open={isOpen} onOpenChange={setIsOpen}>
				<AlertDialogTrigger asChild>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						className="shrink-0"
					>
						Delete project
					</Button>
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete "{projectName}"?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the project from the organization. Anyone with access
							will lose it. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								handleDelete();
							}}
							disabled={isDeleting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isDeleting ? "Deleting…" : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
