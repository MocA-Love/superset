import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import type { ChatService } from "../chat-service";
import { nextEditConfigSchema } from "../chat-service/next-edit-config";
import { getSlashCommands, resolveSlashCommand } from "../slash-commands";
import { searchFiles } from "./file-search";
import { getMcpOverview } from "./mcp-overview";

const t = initTRPC.create({ transformer: superjson });

export const searchFilesInput = z.object({
	rootPath: z.string(),
	query: z.string(),
	includeHidden: z.boolean().default(false),
	limit: z.number().default(20),
});

export const getSlashCommandsInput = z.object({
	cwd: z.string(),
});

export const getMcpOverviewInput = z.object({
	cwd: z.string(),
});

export const resolveSlashCommandInput = z.object({
	cwd: z.string(),
	text: z.string(),
});
export const previewSlashCommandInput = resolveSlashCommandInput;

export const anthropicOAuthCodeInput = z.object({
	code: z.string().min(1),
});

export const openAIOAuthCodeInput = z.object({
	code: z.string().optional(),
});

export const anthropicApiKeyInput = z.object({
	apiKey: z.string().min(1),
});

export const anthropicEnvConfigInput = z.object({
	envText: z.string(),
});

export const openAIApiKeyInput = z.object({
	apiKey: z.string().min(1),
});

export const inceptionApiKeyInput = z.object({
	apiKey: z.string().min(1),
});

export const nextEditCompletionInput = z.object({
	filePath: z.string().min(1),
	currentFileContent: z.string(),
	cursorOffset: z.number().int().min(0),
	recentSnippets: z
		.array(
			z.object({
				filePath: z.string().min(1),
				content: z.string(),
			}),
		)
		.optional(),
	editHistory: z.array(z.string()).optional(),
});

function resolveWorkspaceSlashCommand(input: { cwd: string; text: string }) {
	return resolveSlashCommand(input.cwd, input.text);
}

export function createChatServiceRouter(service: ChatService) {
	return t.router({
		workspace: t.router({
			searchFiles: t.procedure
				.input(searchFilesInput)
				.query(async ({ input }) => {
					return searchFiles({
						rootPath: input.rootPath,
						query: input.query,
						includeHidden: input.includeHidden,
						limit: input.limit,
					});
				}),

			getSlashCommands: t.procedure
				.input(getSlashCommandsInput)
				.query(async ({ input }) => {
					return getSlashCommands(input.cwd);
				}),

			getMcpOverview: t.procedure
				.input(getMcpOverviewInput)
				.query(async ({ input }) => {
					return getMcpOverview(input.cwd);
				}),

			resolveSlashCommand: t.procedure
				.input(resolveSlashCommandInput)
				.mutation(async ({ input }) => {
					return resolveWorkspaceSlashCommand(input);
				}),

			previewSlashCommand: t.procedure
				.input(resolveSlashCommandInput)
				.query(async ({ input }) => {
					return resolveWorkspaceSlashCommand(input);
				}),
		}),

		auth: t.router({
			getAnthropicStatus: t.procedure.query(() => {
				return service.getAnthropicAuthStatus();
			}),
			getOpenAIStatus: t.procedure.query(() => {
				return service.getOpenAIAuthStatus();
			}),
			startOpenAIOAuth: t.procedure.mutation(() => {
				return service.startOpenAIOAuth();
			}),
			completeOpenAIOAuth: t.procedure
				.input(openAIOAuthCodeInput)
				.mutation(async ({ input }) => {
					return service.completeOpenAIOAuth({ code: input.code });
				}),
			cancelOpenAIOAuth: t.procedure.mutation(() => {
				return service.cancelOpenAIOAuth();
			}),
			disconnectOpenAIOAuth: t.procedure.mutation(() => {
				return service.disconnectOpenAIOAuth();
			}),
			startAnthropicOAuth: t.procedure.mutation(() => {
				return service.startAnthropicOAuth();
			}),
			completeAnthropicOAuth: t.procedure
				.input(anthropicOAuthCodeInput)
				.mutation(async ({ input }) => {
					return service.completeAnthropicOAuth({ code: input.code });
				}),
			cancelAnthropicOAuth: t.procedure.mutation(() => {
				return service.cancelAnthropicOAuth();
			}),
			disconnectAnthropicOAuth: t.procedure.mutation(() => {
				return service.disconnectAnthropicOAuth();
			}),
			setAnthropicApiKey: t.procedure
				.input(anthropicApiKeyInput)
				.mutation(({ input }) => {
					return service.setAnthropicApiKey({ apiKey: input.apiKey });
				}),
			getAnthropicEnvConfig: t.procedure.query(() => {
				return service.getAnthropicEnvConfig();
			}),
			setAnthropicEnvConfig: t.procedure
				.input(anthropicEnvConfigInput)
				.mutation(({ input }) => {
					return service.setAnthropicEnvConfig({
						envText: input.envText,
					});
				}),
			clearAnthropicEnvConfig: t.procedure.mutation(() => {
				return service.clearAnthropicEnvConfig();
			}),
			clearAnthropicApiKey: t.procedure.mutation(() => {
				return service.clearAnthropicApiKey();
			}),
			setOpenAIApiKey: t.procedure
				.input(openAIApiKeyInput)
				.mutation(({ input }) => {
					return service.setOpenAIApiKey({ apiKey: input.apiKey });
				}),
			clearOpenAIApiKey: t.procedure.mutation(() => {
				return service.clearOpenAIApiKey();
			}),
			getInceptionStatus: t.procedure.query(() => {
				return service.getInceptionAuthStatus();
			}),
			setInceptionApiKey: t.procedure
				.input(inceptionApiKeyInput)
				.mutation(({ input }) => {
					return service.setInceptionApiKey({ apiKey: input.apiKey });
				}),
			clearInceptionApiKey: t.procedure.mutation(() => {
				return service.clearInceptionApiKey();
			}),
		}),
		nextEdit: t.router({
			getConfig: t.procedure.query(() => {
				return service.getNextEditConfig();
			}),
			setConfig: t.procedure
				.input(nextEditConfigSchema)
				.mutation(({ input }) => {
					return service.setNextEditConfig(input);
				}),
			complete: t.procedure
				.input(nextEditCompletionInput)
				.mutation(({ input }) => {
					return service.completeNextEdit(input);
				}),
		}),
	});
}

export type ChatServiceRouter = ReturnType<typeof createChatServiceRouter>;
