import { electronTrpc } from "renderer/lib/electron-trpc";

export function useCleanupMissingWorktrees() {
	const utils = electronTrpc.useUtils();

	return electronTrpc.workspaces.cleanupMissingWorktrees.useMutation({
		onSuccess: async () => {
			await utils.workspaces.invalidate();
			await utils.projects.getRecents.invalidate();
		},
	});
}
