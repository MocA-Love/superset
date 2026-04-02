import type { ExternalApp } from "@superset/local-db";
import { toast } from "@superset/ui/sonner";
import { useCallback } from "react";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	buildSupersetOpenLink,
	type SupersetLinkProject,
} from "renderer/lib/superset-open-links";

interface UsePathActionsProps {
	absolutePath: string | null;
	relativePath?: string;
	branch?: string | null;
	/** For files: pass cwd to use openFileInEditor. For folders: omit to use openInApp */
	cwd?: string;
	/** Pre-resolved app to avoid per-row default-app queries */
	defaultApp?: ExternalApp | null;
	/** Project identifier for project-scoped actions/metadata */
	projectId?: string;
	supersetLinkProject?: SupersetLinkProject | null;
}

export function usePathActions({
	absolutePath,
	relativePath,
	branch,
	cwd,
	defaultApp,
	projectId,
	supersetLinkProject,
}: UsePathActionsProps) {
	const openInFinderMutation = electronTrpc.external.openInFinder.useMutation();
	const openInAppMutation = electronTrpc.external.openInApp.useMutation({
		onError: (error) =>
			toast.error("Failed to open in app", {
				description: error.message,
			}),
	});
	const openFileInEditorMutation =
		electronTrpc.external.openFileInEditor.useMutation({
			onError: (error) =>
				toast.error("Failed to open in editor", {
					description: error.message,
				}),
		});

	const { copyToClipboard } = useCopyToClipboard();

	const copyPath = useCallback(() => {
		if (absolutePath) {
			copyToClipboard(absolutePath);
		}
	}, [absolutePath, copyToClipboard]);

	const copyRelativePath = useCallback(() => {
		if (relativePath) {
			copyToClipboard(relativePath);
		}
	}, [relativePath, copyToClipboard]);

	const copySupersetLink = useCallback(() => {
		if (!relativePath || !supersetLinkProject) {
			toast.error("Superset link is unavailable", {
				description: "Project metadata is still loading.",
			});
			return;
		}

		const link = buildSupersetOpenLink({
			project: supersetLinkProject,
			branch,
			filePath: relativePath,
		});

		if (!link) {
			toast.error("Failed to build Superset link", {
				description: "Repository metadata is incomplete.",
			});
			return;
		}

		void copyToClipboard(link).catch((error) => {
			console.error("[superset-link] Failed to copy link:", error);
			toast.error("Failed to copy Superset link", {
				description: error instanceof Error ? error.message : undefined,
			});
		});
	}, [branch, copyToClipboard, relativePath, supersetLinkProject]);

	const revealInFinder = useCallback(() => {
		if (absolutePath) {
			openInFinderMutation.mutate(absolutePath);
		}
	}, [absolutePath, openInFinderMutation]);

	const openInEditor = useCallback(() => {
		if (!absolutePath) return;

		if (cwd) {
			openFileInEditorMutation.mutate({ path: absolutePath, cwd, projectId });
		} else {
			// Avoid opening with an incorrect fallback before upstream default app query resolves.
			if (defaultApp === undefined) {
				toast.error("Editor preference is still loading", {
					description: "Try again in a moment.",
				});
				return;
			}

			if (!defaultApp) {
				toast.error("No default editor configured", {
					description:
						"Open a file in an editor first to set a project default editor.",
				});
				return;
			}

			openInAppMutation.mutate({
				path: absolutePath,
				app: defaultApp,
				projectId,
			});
		}
	}, [
		absolutePath,
		cwd,
		projectId,
		defaultApp,
		openInAppMutation,
		openFileInEditorMutation,
	]);

	return {
		copyPath,
		copyRelativePath,
		copySupersetLink,
		revealInFinder,
		openInEditor,
		hasRelativePath: Boolean(relativePath),
		hasSupersetLink: Boolean(relativePath && supersetLinkProject),
	};
}
