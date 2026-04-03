import { readFile, writeFile } from "node:fs/promises";
import {
	EXTERNAL_APPS,
	NON_EDITOR_APPS,
	projects,
	settings,
} from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
	BrowserWindow,
	clipboard,
	dialog,
	type OpenDialogOptions,
	shell,
} from "electron";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	type ExternalApp,
	getAppCommand,
	resolvePath,
	spawnAsync,
} from "./helpers";

const ExternalAppSchema = z.enum(EXTERNAL_APPS);
const FileFilterSchema = z.object({
	name: z.string(),
	extensions: z.array(z.string()),
});

const nonEditorSet = new Set<ExternalApp>(NON_EDITOR_APPS);

function isMissingExternalAppError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.includes("Unable to find application named") ||
		error.message.includes("Ensure the application is installed.")
	);
}

function normalizeOpenInAppError(error: unknown): never {
	if (isMissingExternalAppError(error)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Requested application is not available",
		});
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: error instanceof Error ? error.message : "Unknown error",
	});
}

/** Sets the global default editor if one hasn't been set yet. Skips non-editor apps. */
function ensureGlobalDefaultEditor(app: ExternalApp) {
	if (nonEditorSet.has(app)) return;

	const row = localDb.select().from(settings).get();
	if (!row?.defaultEditor) {
		localDb
			.insert(settings)
			.values({ id: 1, defaultEditor: app })
			.onConflictDoUpdate({
				target: settings.id,
				set: { defaultEditor: app },
			})
			.run();
	}
}

/** Resolves the default editor from project setting, then global setting. */
export function resolveDefaultEditor(projectId?: string): ExternalApp | null {
	if (projectId) {
		const project = localDb
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (project?.defaultApp) return project.defaultApp;
	}
	const row = localDb.select().from(settings).get();
	return row?.defaultEditor ?? null;
}

async function openPathInApp(
	filePath: string,
	app: ExternalApp,
): Promise<void> {
	if (app === "finder") {
		shell.showItemInFolder(filePath);
		return;
	}

	const candidates = getAppCommand(app, filePath);
	if (candidates) {
		let lastError: Error | undefined;
		for (const cmd of candidates) {
			try {
				await spawnAsync(cmd.command, cmd.args);
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (candidates.length > 1) {
					console.warn(
						`[external/openInApp] ${cmd.args[1]} not found, trying next candidate`,
					);
				}
			}
		}
		throw lastError;
	}

	const openError = await shell.openPath(filePath);
	if (openError) {
		throw new Error(openError);
	}
}

/**
 * External operations router.
 * Handles opening URLs and files in external applications.
 */
export const createExternalRouter = () => {
	return router({
		openUrl: publicProcedure.input(z.string()).mutation(async ({ input }) => {
			try {
				await shell.openExternal(input);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				console.error("[external/openUrl] Failed to open URL:", input, error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: errorMessage,
				});
			}
		}),

		openInFinder: publicProcedure
			.input(z.string())
			.mutation(async ({ input }) => {
				shell.showItemInFolder(input);
			}),

		openInDefaultApp: publicProcedure
			.input(z.string())
			.mutation(async ({ input }) => {
				const openError = await shell.openPath(input);
				if (openError) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: openError,
					});
				}
			}),

		openInApp: publicProcedure
			.input(
				z.object({
					path: z.string(),
					app: ExternalAppSchema,
					projectId: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				try {
					await openPathInApp(input.path, input.app);
				} catch (error) {
					normalizeOpenInAppError(error);
				}

				// Persist defaults only after successful launch
				if (input.projectId) {
					localDb
						.update(projects)
						.set({ defaultApp: input.app })
						.where(eq(projects.id, input.projectId))
						.run();
				}

				// Auto-set global default editor on first successful use (best-effort)
				try {
					ensureGlobalDefaultEditor(input.app);
				} catch (err) {
					console.warn(
						"[external/openInApp] Failed to persist global default editor:",
						err,
					);
				}
			}),

		copyPath: publicProcedure.input(z.string()).mutation(async ({ input }) => {
			clipboard.writeText(input);
		}),

		copyText: publicProcedure.input(z.string()).mutation(async ({ input }) => {
			clipboard.writeText(input);
		}),

		openTextFile: publicProcedure
			.input(
				z.object({
					title: z.string().optional(),
					buttonLabel: z.string().optional(),
					filters: z.array(FileFilterSchema).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const window = BrowserWindow.getFocusedWindow();
				const options: OpenDialogOptions = {
					title: input.title,
					buttonLabel: input.buttonLabel,
					filters: input.filters,
					properties: ["openFile"],
				};
				const result = window
					? await dialog.showOpenDialog(window, options)
					: await dialog.showOpenDialog(options);

				if (result.canceled || result.filePaths.length === 0) {
					return null;
				}

				const filePath = result.filePaths[0];
				if (!filePath) {
					return null;
				}

				const content = await readFile(filePath, "utf-8");
				return {
					path: filePath,
					content,
				};
			}),

		saveTextFile: publicProcedure
			.input(
				z.object({
					title: z.string().optional(),
					defaultPath: z.string().optional(),
					buttonLabel: z.string().optional(),
					filters: z.array(FileFilterSchema).optional(),
					content: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const window = BrowserWindow.getFocusedWindow();
				const options = {
					title: input.title,
					defaultPath: input.defaultPath,
					buttonLabel: input.buttonLabel,
					filters: input.filters,
				};
				const result = window
					? await dialog.showSaveDialog(window, options)
					: await dialog.showSaveDialog(options);

				if (result.canceled || !result.filePath) {
					return null;
				}

				await writeFile(result.filePath, input.content, "utf-8");
				return {
					path: result.filePath,
				};
			}),

		resolvePath: publicProcedure
			.input(
				z.object({
					path: z.string(),
					cwd: z.string().optional(),
				}),
			)
			.query(({ input }) => resolvePath(input.path, input.cwd)),

		openFileInEditor: publicProcedure
			.input(
				z.object({
					path: z.string(),
					line: z.number().optional(),
					column: z.number().optional(),
					cwd: z.string().optional(),
					projectId: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const filePath = resolvePath(input.path, input.cwd);
				const app = resolveDefaultEditor(input.projectId);

				if (!app) {
					// No preferred editor configured yet.
					// Fall back to OS default file handler so Cmd/Ctrl+click still works
					// even when Cursor (or any specific editor) isn't installed.
					const openError = await shell.openPath(filePath);
					if (openError) {
						throw new Error(openError);
					}
					return;
				}

				try {
					await openPathInApp(filePath, app);
				} catch (error) {
					normalizeOpenInAppError(error);
				}
			}),
	});
};

export type ExternalRouter = ReturnType<typeof createExternalRouter>;
