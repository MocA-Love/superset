import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observable } from "@trpc/server/observable";
import type { WebviewBridgeEvent } from "main/lib/vscode-shim/webview-bridge";
import { webviewBridge } from "main/lib/vscode-shim/webview-bridge";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/** Known VS Code extensions that can be managed */
const KNOWN_EXTENSIONS = [
	{
		id: "anthropic.claude-code",
		name: "Claude Code",
		publisher: "Anthropic",
		description: "AI coding assistant by Anthropic",
		marketplaceUrl:
			"https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code",
		viewType: "claudeVSCodeSidebar",
	},
	{
		id: "openai.chatgpt",
		name: "ChatGPT / Codex",
		publisher: "OpenAI",
		description: "AI coding assistant by OpenAI",
		marketplaceUrl:
			"https://marketplace.visualstudio.com/items?itemName=openai.chatgpt",
		viewType: "chatgpt.sidebarView",
	},
] as const;

function getExtensionsDir(): string {
	return path.join(os.homedir(), ".vscode", "extensions");
}

function isExtensionInstalled(extensionId: string): boolean {
	const dir = getExtensionsDir();
	if (!fs.existsSync(dir)) return false;
	const entries = fs.readdirSync(dir);
	return entries.some((entry) =>
		entry.toLowerCase().startsWith(extensionId.toLowerCase()),
	);
}

export const createVscodeExtensionsRouter = () => {
	return router({
		/** Get list of loaded (active) extensions */
		getExtensions: publicProcedure.query(() => {
			const { getActiveExtensions } =
				require("main/lib/vscode-shim") as typeof import("main/lib/vscode-shim");
			return getActiveExtensions();
		}),

		/** Get all known extensions with their install/active status */
		getKnownExtensions: publicProcedure.query(() => {
			let activeExtensions: Array<{ id: string; isActive: boolean }> = [];
			try {
				const { getActiveExtensions } =
					require("main/lib/vscode-shim") as typeof import("main/lib/vscode-shim");
				activeExtensions = getActiveExtensions();
			} catch {}

			return KNOWN_EXTENSIONS.map((ext) => {
				const active = activeExtensions.find((a) => a.id === ext.id);
				return {
					...ext,
					installed: isExtensionInstalled(ext.id),
					active: active?.isActive ?? false,
				};
			});
		}),

		/** Resolve a webview view for a given viewType, returns initial HTML */
		resolveWebview: publicProcedure
			.input(
				z.object({
					viewType: z.string(),
					extensionPath: z.string(),
				}),
			)
			.mutation(({ input }) => {
				const viewId = webviewBridge.resolveView(
					input.viewType,
					input.extensionPath,
				);
				if (!viewId) {
					return { viewId: null, html: null };
				}
				const html = webviewBridge.getHtml(viewId) ?? null;
				return { viewId, html };
			}),

		/** Get current webview HTML */
		getWebviewHtml: publicProcedure
			.input(z.object({ viewType: z.string() }))
			.query(({ input }) => {
				const viewId = webviewBridge.getViewId(input.viewType);
				if (!viewId) return null;
				return webviewBridge.getHtml(viewId) ?? null;
			}),

		/** Send a message from renderer to extension webview */
		postMessageToExtension: publicProcedure
			.input(
				z.object({
					viewId: z.string(),
					message: z.unknown(),
				}),
			)
			.mutation(({ input }) => {
				webviewBridge.postMessageToExtension(input.viewId, input.message);
				return { success: true };
			}),

		/** Notify main process of active file change (for activeTextEditor) */
		setActiveEditor: publicProcedure
			.input(
				z.object({
					filePath: z.string().nullable(),
					languageId: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { setActiveTextEditor } =
					require("main/lib/vscode-shim") as typeof import("main/lib/vscode-shim");
				setActiveTextEditor(input.filePath, input.languageId);
				return { success: true };
			}),

		/** Restart a specific extension */
		restartExtension: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				const { restartExtension } =
					require("main/lib/vscode-shim/extension-host") as typeof import("main/lib/vscode-shim/extension-host");
				const success = await restartExtension(input.extensionId);
				return { success };
			}),

		/** Subscribe to webview events (HTML changes, messages from extension) */
		subscribeWebview: publicProcedure.subscription(() => {
			return observable<WebviewBridgeEvent>((emit) => {
				const handler = (event: WebviewBridgeEvent) => {
					emit.next(event);
				};
				webviewBridge.on("webview-event", handler);
				return () => {
					webviewBridge.off("webview-event", handler);
				};
			});
		}),
	});
};
