import { TRPCError } from "@trpc/server";
import { buildReferenceGraph } from "main/lib/reference-graph";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspace } from "../workspaces/utils/db-helpers";
import { getWorkspacePath } from "../workspaces/utils/worktree";

function resolveWorkspacePath(workspaceId: string): string {
	const workspace = getWorkspace(workspaceId);
	if (!workspace) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Workspace ${workspaceId} not found`,
		});
	}

	const workspacePath = getWorkspacePath(workspace);
	if (!workspacePath) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Workspace ${workspaceId} has no filesystem path`,
		});
	}

	return workspacePath;
}

export const createReferenceGraphRouter = () => {
	return router({
		buildGraph: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
					line: z.number().int().positive(),
					column: z.number().int().positive(),
					maxDepth: z.number().int().min(1).max(10).optional(),
					maxNodes: z.number().int().min(1).max(500).optional(),
					excludePatterns: z.array(z.string()).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);

				const graph = await buildReferenceGraph({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
					maxDepth: input.maxDepth,
					maxNodes: input.maxNodes,
					excludePatterns: input.excludePatterns,
				});

				return graph;
			}),
	});
};
