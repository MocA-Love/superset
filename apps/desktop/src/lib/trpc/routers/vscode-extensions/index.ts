import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { webviewBridge } from "main/lib/vscode-shim/webview-bridge";
import type { WebviewBridgeEvent } from "main/lib/vscode-shim/webview-bridge";

export const createVscodeExtensionsRouter = () => {
	return router({
		/** Get list of loaded extensions */
		getExtensions: publicProcedure.query(() => {
			const { getActiveExtensions } =
				require("main/lib/vscode-shim") as typeof import("main/lib/vscode-shim");
			return getActiveExtensions();
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
