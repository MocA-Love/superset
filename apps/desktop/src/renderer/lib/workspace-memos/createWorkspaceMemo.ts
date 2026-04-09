import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	createWorkspaceMemoContext,
	type WorkspaceMemoContext,
} from "./memo-paths";

const INITIAL_MEMO_CONTENT = "";

export async function createWorkspaceMemo(
	workspaceId: string,
): Promise<WorkspaceMemoContext> {
	const workspace = await electronTrpcClient.workspaces.get.query({
		id: workspaceId,
	});
	if (!workspace?.worktreePath) {
		throw new Error(`Workspace path not found: ${workspaceId}`);
	}

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const memo = createWorkspaceMemoContext(workspace.worktreePath);
		await electronTrpcClient.filesystem.createDirectory.mutate({
			workspaceId,
			absolutePath: memo.assetsDirectoryAbsolutePath,
			recursive: true,
		});

		const result = await electronTrpcClient.filesystem.writeFile.mutate({
			workspaceId,
			absolutePath: memo.memoFileAbsolutePath,
			content: INITIAL_MEMO_CONTENT,
			encoding: "utf-8",
			options: {
				create: true,
				overwrite: false,
			},
		});

		if (result.ok) {
			return memo;
		}

		if (result.reason !== "exists") {
			throw new Error(`Failed to create memo: ${result.reason}`);
		}
	}

	throw new Error("Failed to create memo after multiple attempts");
}
