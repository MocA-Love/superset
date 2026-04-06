import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useWorkspaceId } from "../WorkspaceIdContext";

/**
 * Syncs the active workspace path and focused file to the VS Code extension host.
 * - workspace path → vscode.workspace.workspaceFolders (needed for extensions to operate)
 * - focused file → vscode.window.activeTextEditor
 */
export function useActiveEditorSync() {
	const workspaceId = useWorkspaceId();
	const activeTabIds = useTabsStore((s) => s.activeTabIds);
	const focusedPaneIds = useTabsStore((s) => s.focusedPaneIds);
	const panes = useTabsStore((s) => s.panes);
	const lastFilePath = useRef<string | null>(null);
	const lastWorkspacePath = useRef<string | null>(null);

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);

	const setActiveEditorMutation =
		electronTrpc.vscodeExtensions.setActiveEditor.useMutation();
	const setWorkspacePathMutation =
		electronTrpc.vscodeExtensions.setWorkspacePath.useMutation();

	// Sync workspace path when workspace changes
	useEffect(() => {
		const worktreePath = workspace?.worktreePath;
		if (!worktreePath) return;
		if (worktreePath === lastWorkspacePath.current) return;

		lastWorkspacePath.current = worktreePath;
		setWorkspacePathMutation.mutate({ workspacePath: worktreePath });
	}, [workspace?.worktreePath, setWorkspacePathMutation.mutate]);

	// Sync active file
	useEffect(() => {
		if (!workspaceId) return;

		const activeTabId = activeTabIds[workspaceId];
		if (!activeTabId) return;

		const focusedPaneId = focusedPaneIds[activeTabId];
		if (!focusedPaneId) return;

		const pane = panes[focusedPaneId];
		if (!pane) return;

		let filePath: string | null = null;
		let languageId: string | undefined;

		if (pane.type === "file-viewer" && pane.fileViewer?.filePath) {
			filePath = pane.fileViewer.filePath;
			const ext = filePath.split(".").pop()?.toLowerCase();
			const EXT_TO_LANG: Record<string, string> = {
				ts: "typescript",
				tsx: "typescriptreact",
				js: "javascript",
				jsx: "javascriptreact",
				py: "python",
				rs: "rust",
				go: "go",
				json: "json",
				md: "markdown",
				css: "css",
				html: "html",
				yaml: "yaml",
				yml: "yaml",
				toml: "toml",
				sh: "shellscript",
				sql: "sql",
			};
			languageId = ext ? (EXT_TO_LANG[ext] ?? ext) : "plaintext";
		}

		if (filePath !== lastFilePath.current) {
			lastFilePath.current = filePath;
			setActiveEditorMutation.mutate({ filePath, languageId });
		}
	}, [
		workspaceId,
		activeTabIds,
		focusedPaneIds,
		panes,
		setActiveEditorMutation.mutate,
	]);
}
