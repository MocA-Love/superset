import {
	toErrorMessage,
	WorkspaceFsPathError,
} from "@superset/workspace-fs/host";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getServiceForWorkspace } from "../workspace-fs-service";

function isClosedStreamError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		"code" in error &&
		error.code === "ERR_INVALID_STATE"
	);
}

function getErrorCode(error: unknown): string | null {
	if (!(error instanceof Error) || !("code" in error)) {
		return null;
	}

	return typeof error.code === "string" ? error.code : null;
}

function throwFilesystemError(error: unknown): never {
	if (error instanceof TRPCError) {
		throw error;
	}

	// Most filesystem failures here are expected user/state conditions, so normalize
	// them to typed tRPC errors and reserve INTERNAL_SERVER_ERROR for real surprises.
	if (error instanceof WorkspaceFsPathError) {
		switch (error.code) {
			case "OUTSIDE_ROOT":
			case "INVALID_TARGET":
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error.message,
				});
			case "SYMLINK_ESCAPE":
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: error.message,
				});
		}
	}

	const errorCode = getErrorCode(error);
	if (errorCode === "ENOENT") {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: toErrorMessage(error),
		});
	}
	if (
		errorCode === "EISDIR" ||
		errorCode === "ENOTDIR" ||
		errorCode === "ERR_FS_EISDIR"
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: toErrorMessage(error),
		});
	}
	if (errorCode === "EACCES" || errorCode === "EPERM") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: toErrorMessage(error),
		});
	}
	if (errorCode === "EEXIST") {
		throw new TRPCError({
			code: "CONFLICT",
			message: toErrorMessage(error),
		});
	}
	if (
		error instanceof Error &&
		error.message.includes("Path is outside workspace root")
	) {
		// workspace-fs still emits a plain Error for some outside-root checks.
		// Keep this router-side fallback until that package fully types the error.
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error.message,
		});
	}

	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: toErrorMessage(error),
	});
}

async function withFilesystemErrorBoundary<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		// Keep every filesystem procedure aligned on the same error semantics.
		throwFilesystemError(error);
	}
}

const writeFileContentSchema = z.union([
	z.string(),
	z.object({
		kind: z.literal("base64"),
		data: z.string(),
	}),
]);

type WatchPathEventBatch = {
	events: Array<{
		kind: string;
		absolutePath: string;
		oldAbsolutePath?: string;
	}>;
};

const searchContentInputSchema = z.object({
	workspaceId: z.string(),
	query: z.string(),
	includeHidden: z.boolean().optional(),
	includePattern: z.string().optional(),
	excludePattern: z.string().optional(),
	limit: z.number().optional(),
	isRegex: z.boolean().optional(),
	caseSensitive: z.boolean().optional(),
});

const replaceContentInputSchema = z.object({
	workspaceId: z.string(),
	query: z.string(),
	replacement: z.string(),
	includeHidden: z.boolean().optional(),
	includePattern: z.string().optional(),
	excludePattern: z.string().optional(),
	isRegex: z.boolean().optional(),
	caseSensitive: z.boolean().optional(),
	paths: z.array(z.string()).optional(),
});

export const createFilesystemRouter = () => {
	return router({
		listDirectory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
				}),
			)
			.query(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.listDirectory({
						absolutePath: input.absolutePath,
					});
				});
			}),

		readFile: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					offset: z.number().optional(),
					maxBytes: z.number().optional(),
					encoding: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					const result = await service.readFile({
						absolutePath: input.absolutePath,
						offset: input.offset,
						maxBytes: input.maxBytes,
						encoding: input.encoding,
					});

					if (result.kind === "bytes") {
						return {
							...result,
							content: Buffer.from(result.content).toString("base64"),
						};
					}

					return result;
				});
			}),

		getMetadata: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
				}),
			)
			.query(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.getMetadata({
						absolutePath: input.absolutePath,
					});
				});
			}),

		writeFile: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					content: writeFileContentSchema,
					encoding: z.string().optional(),
					options: z
						.object({
							create: z.boolean(),
							overwrite: z.boolean(),
						})
						.optional(),
					precondition: z
						.object({
							ifMatch: z.string(),
						})
						.optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					const content =
						typeof input.content === "string"
							? input.content
							: new Uint8Array(Buffer.from(input.content.data, "base64"));

					return await service.writeFile({
						absolutePath: input.absolutePath,
						content,
						encoding: input.encoding,
						options: input.options,
						precondition: input.precondition,
					});
				});
			}),

		createDirectory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					recursive: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.createDirectory({
						absolutePath: input.absolutePath,
						recursive: input.recursive,
					});
				});
			}),

		deletePath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					permanent: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.deletePath({
						absolutePath: input.absolutePath,
						permanent: input.permanent,
					});
				});
			}),

		movePath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					sourceAbsolutePath: z.string(),
					destinationAbsolutePath: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.movePath({
						sourceAbsolutePath: input.sourceAbsolutePath,
						destinationAbsolutePath: input.destinationAbsolutePath,
					});
				});
			}),

		copyPath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					sourceAbsolutePath: z.string(),
					destinationAbsolutePath: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.copyPath({
						sourceAbsolutePath: input.sourceAbsolutePath,
						destinationAbsolutePath: input.destinationAbsolutePath,
					});
				});
			}),

		searchFiles: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					query: z.string(),
					includeHidden: z.boolean().optional(),
					includePattern: z.string().optional(),
					excludePattern: z.string().optional(),
					limit: z.number().optional(),
				}),
			)
			.query(async ({ input }) => {
				const trimmedQuery = input.query.trim();
				if (!trimmedQuery) {
					return { matches: [] };
				}

				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.searchFiles({
						query: trimmedQuery,
						includeHidden: input.includeHidden,
						includePattern: input.includePattern,
						excludePattern: input.excludePattern,
						limit: input.limit,
					});
				});
			}),

		searchContent: publicProcedure
			.input(searchContentInputSchema)
			.query(async ({ input }) => {
				const trimmedQuery = input.query.trim();
				if (!trimmedQuery) {
					return { matches: [] };
				}

				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.searchContent({
						query: trimmedQuery,
						includeHidden: input.includeHidden,
						includePattern: input.includePattern,
						excludePattern: input.excludePattern,
						limit: input.limit,
						isRegex: input.isRegex,
						caseSensitive: input.caseSensitive,
					});
				});
			}),

		replaceContent: publicProcedure
			.input(replaceContentInputSchema)
			.mutation(async ({ input }) => {
				if (input.query.length === 0) {
					return {
						replacements: 0,
						filesUpdated: 0,
						updated: [],
						conflicts: [],
						failed: [],
					};
				}

				return await withFilesystemErrorBoundary(async () => {
					const service = getServiceForWorkspace(input.workspaceId);
					return await service.replaceContent({
						query: input.query,
						replacement: input.replacement,
						includeHidden: input.includeHidden,
						includePattern: input.includePattern,
						excludePattern: input.excludePattern,
						isRegex: input.isRegex,
						caseSensitive: input.caseSensitive,
						paths: input.paths,
					});
				});
			}),

		watchPath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					absolutePath: z.string(),
					recursive: z.boolean().optional(),
				}),
			)
			.subscription(({ input }) => {
				return observable<WatchPathEventBatch>((emit) => {
					const service = getServiceForWorkspace(input.workspaceId);
					let isDisposed = false;
					const stream = service.watchPath({
						absolutePath: input.absolutePath,
						recursive: input.recursive,
					});
					const iterator = stream[Symbol.asyncIterator]();

					const runCleanup = () => {
						isDisposed = true;
						void iterator.return?.().catch((error) => {
							console.error("[filesystem/watchPath] Cleanup failed:", {
								workspaceId: input.workspaceId,
								error,
							});
						});
					};

					const emitIfOpen = (value: WatchPathEventBatch): boolean => {
						try {
							emit.next(value);
							return true;
						} catch (error) {
							if (isClosedStreamError(error)) {
								runCleanup();
								return false;
							}

							throw error;
						}
					};

					void (async () => {
						try {
							while (!isDisposed) {
								const next = await iterator.next();
								if (next.done || isDisposed) {
									return;
								}

								if (!emitIfOpen(next.value)) {
									return;
								}
							}
						} catch (error) {
							console.error("[filesystem/watchPath] Failed:", {
								workspaceId: input.workspaceId,
								error: toErrorMessage(error),
							});

							if (
								emitIfOpen({
									events: [
										{
											kind: "overflow",
											absolutePath: input.absolutePath,
										},
									],
								})
							) {
								runCleanup();
							}
						}
					})();

					return () => {
						runCleanup();
					};
				});
			}),
	});
};
