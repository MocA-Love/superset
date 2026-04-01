import { observable } from "@trpc/server/observable";
import { TRPCError } from "@trpc/server";
import { languageServiceManager } from "main/lib/language-services/manager";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspace } from "../workspaces/utils/db-helpers";
import { getWorkspacePath } from "../workspaces/utils/worktree";

const languageServiceDocumentSchema = z.object({
	workspaceId: z.string(),
	absolutePath: z.string(),
	languageId: z.string(),
	content: z.string(),
	version: z.number().int().nonnegative(),
});

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

export const createLanguageServicesRouter = () => {
	return router({
		openDocument: publicProcedure
			.input(languageServiceDocumentSchema)
			.mutation(async ({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);
				console.log("[languageServices router] openDocument", {
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					version: input.version,
					contentLength: input.content.length,
				});
				await languageServiceManager.openDocument({
					...input,
					workspacePath,
				});
				return { ok: true };
			}),

		changeDocument: publicProcedure
			.input(languageServiceDocumentSchema)
			.mutation(async ({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);
				console.log("[languageServices router] changeDocument", {
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					version: input.version,
					contentLength: input.content.length,
				});
				await languageServiceManager.syncDocument({
					...input,
					workspacePath,
				});
				return { ok: true };
			}),

		closeDocument: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);
				console.log("[languageServices router] closeDocument", {
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
				});
				await languageServiceManager.closeDocument({
					...input,
					workspacePath,
				});
				return { ok: true };
			}),

		refreshWorkspace: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);
				console.log("[languageServices router] refreshWorkspace", {
					workspaceId: input.workspaceId,
					workspacePath,
				});
				await languageServiceManager.refreshWorkspace({
					workspaceId: input.workspaceId,
					workspacePath,
				});
				return { ok: true };
			}),

		getWorkspaceDiagnostics: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
				}),
			)
			.query(({ input }) => {
				const workspacePath = resolveWorkspacePath(input.workspaceId);
				const snapshot = languageServiceManager.getWorkspaceSnapshot({
					workspaceId: input.workspaceId,
					workspacePath,
				});
				console.log("[languageServices router] getWorkspaceDiagnostics", {
					workspaceId: input.workspaceId,
					workspacePath,
					totalCount: snapshot.totalCount,
					providers: snapshot.providers,
					problemFiles: snapshot.problems.map(
						(problem) => problem.relativePath ?? "Workspace",
					),
				});
				return snapshot;
			}),

		subscribeDiagnostics: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
				}),
			)
			.subscription(({ input }) => {
				return observable<{ version: number }>((emit) => {
					console.log("[languageServices router] subscribeDiagnostics", {
						workspaceId: input.workspaceId,
					});
					const unsubscribe = languageServiceManager.subscribeToWorkspace(
						input.workspaceId,
						(payload) => {
							console.log("[languageServices router] subscribeDiagnostics event", {
								workspaceId: input.workspaceId,
								version: payload.version,
							});
							emit.next(payload);
						},
					);

					return () => {
						unsubscribe();
					};
				});
			}),
	});
};
