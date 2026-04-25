import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
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

const languageServicePositionSchema = z.object({
	workspaceId: z.string(),
	absolutePath: z.string(),
	languageId: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive(),
	content: z.string().optional(),
	version: z.number().int().nonnegative().optional(),
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

async function syncLookupDocumentIfNeeded(
	input: z.infer<typeof languageServicePositionSchema>,
): Promise<string> {
	const workspacePath = resolveWorkspacePath(input.workspaceId);
	if (input.content === undefined || input.version === undefined) {
		return workspacePath;
	}

	await languageServiceManager.syncDocument({
		workspaceId: input.workspaceId,
		workspacePath,
		absolutePath: input.absolutePath,
		languageId: input.languageId,
		content: input.content,
		version: input.version,
	});
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

		getHover: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getHover({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		getDefinition: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getDefinition({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		findReferences: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.findReferences({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		getTypeDefinition: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getTypeDefinition({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		getImplementation: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getImplementation({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		getDocumentHighlights: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getDocumentHighlights({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		getCompletion: publicProcedure
			.input(
				languageServicePositionSchema.extend({
					triggerKind: z
						.union([z.literal(1), z.literal(2), z.literal(3)])
						.optional(),
					triggerCharacter: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getCompletion({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
					triggerKind: input.triggerKind,
					triggerCharacter: input.triggerCharacter,
				});
			}),

		resolveCompletionItem: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					languageId: z.string(),
					item: z.unknown(),
				}),
			)
			.query(async ({ input }) => {
				return await languageServiceManager.resolveCompletionItem({
					workspaceId: input.workspaceId,
					languageId: input.languageId,
					// biome-ignore lint/suspicious/noExplicitAny: round-trip LSP item
					item: input.item as any,
				});
			}),

		getSignatureHelp: publicProcedure
			.input(
				languageServicePositionSchema.extend({
					triggerKind: z
						.union([z.literal(1), z.literal(2), z.literal(3)])
						.optional(),
					triggerCharacter: z.string().optional(),
					isRetrigger: z.boolean().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.getSignatureHelp({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
					triggerKind: input.triggerKind,
					triggerCharacter: input.triggerCharacter,
					isRetrigger: input.isRetrigger,
				});
			}),

		getCodeActions: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
					startLine: z.number().int().positive(),
					startColumn: z.number().int().positive(),
					endLine: z.number().int().positive(),
					endColumn: z.number().int().positive(),
					content: z.string().optional(),
					version: z.number().int().nonnegative().optional(),
					only: z.array(z.string()).optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded({
					workspaceId: input.workspaceId,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.startLine,
					column: input.startColumn,
					content: input.content,
					version: input.version,
				});
				return await languageServiceManager.getCodeActions({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					startLine: input.startLine,
					startColumn: input.startColumn,
					endLine: input.endLine,
					endColumn: input.endColumn,
					only: input.only,
				});
			}),

		resolveCodeAction: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					languageId: z.string(),
					action: z.unknown(),
				}),
			)
			.query(async ({ input }) => {
				return await languageServiceManager.resolveCodeAction({
					workspaceId: input.workspaceId,
					languageId: input.languageId,
					// biome-ignore lint/suspicious/noExplicitAny: round-trip LSP action
					action: input.action as any,
				});
			}),

		prepareRename: publicProcedure
			.input(languageServicePositionSchema)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.prepareRename({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
				});
			}),

		rename: publicProcedure
			.input(
				languageServicePositionSchema.extend({ newName: z.string().min(1) }),
			)
			.mutation(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded(input);
				return await languageServiceManager.rename({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.line,
					column: input.column,
					newName: input.newName,
				});
			}),

		applyWorkspaceEdit: publicProcedure
			.input(
				z.object({
					edit: z.object({
						changes: z.array(
							z.object({
								absolutePath: z.string(),
								edits: z.array(
									z.object({
										range: z.object({
											line: z.number().int().positive(),
											column: z.number().int().positive(),
											endLine: z.number().int().positive(),
											endColumn: z.number().int().positive(),
										}),
										newText: z.string(),
									}),
								),
							}),
						),
					}),
				}),
			)
			.mutation(async ({ input }) => {
				return await languageServiceManager.applyWorkspaceEdit(input.edit);
			}),

		getInlayHints: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
					startLine: z.number().int().positive(),
					startColumn: z.number().int().positive(),
					endLine: z.number().int().positive(),
					endColumn: z.number().int().positive(),
					content: z.string().optional(),
					version: z.number().int().nonnegative().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded({
					workspaceId: input.workspaceId,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: input.startLine,
					column: input.startColumn,
					content: input.content,
					version: input.version,
				});
				return await languageServiceManager.getInlayHints({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					startLine: input.startLine,
					startColumn: input.startColumn,
					endLine: input.endLine,
					endColumn: input.endColumn,
				});
			}),

		getSemanticTokens: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
					content: z.string().optional(),
					version: z.number().int().nonnegative().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded({
					workspaceId: input.workspaceId,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: 1,
					column: 1,
					content: input.content,
					version: input.version,
				});
				return await languageServiceManager.getSemanticTokens({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
				});
			}),

		getSemanticTokensLegend: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					languageId: z.string(),
				}),
			)
			.query(({ input }) => {
				return languageServiceManager.getSemanticTokensLegend({
					workspaceId: input.workspaceId,
					languageId: input.languageId,
				});
			}),

		getDocumentSymbols: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					languageId: z.string(),
					content: z.string().optional(),
					version: z.number().int().nonnegative().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspacePath = await syncLookupDocumentIfNeeded({
					workspaceId: input.workspaceId,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
					line: 1,
					column: 1,
					content: input.content,
					version: input.version,
				});
				return await languageServiceManager.getDocumentSymbols({
					workspaceId: input.workspaceId,
					workspacePath,
					absolutePath: input.absolutePath,
					languageId: input.languageId,
				});
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
