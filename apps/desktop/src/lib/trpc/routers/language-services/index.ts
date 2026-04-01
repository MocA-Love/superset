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
				return languageServiceManager.getWorkspaceSnapshot({
					workspaceId: input.workspaceId,
					workspacePath,
				});
			}),

		getProviders: publicProcedure.query(() => {
			return languageServiceManager.getProviders();
		}),

		setProviderEnabled: publicProcedure
			.input(
				z.object({
					providerId: z.string(),
					enabled: z.boolean(),
				}),
			)
			.mutation(async ({ input }) => {
				const provider = await languageServiceManager.setProviderEnabled(
					input.providerId,
					input.enabled,
				);
				if (!provider) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Language service provider ${input.providerId} not found`,
					});
				}

				return provider;
			}),

		subscribeDiagnostics: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
				}),
			)
			.subscription(({ input }) => {
				return observable<{ version: number }>((emit) => {
					const unsubscribe = languageServiceManager.subscribeToWorkspace(
						input.workspaceId,
						(payload) => {
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
