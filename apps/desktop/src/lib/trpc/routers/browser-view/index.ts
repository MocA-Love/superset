import { observable } from "@trpc/server/observable";
import { BrowserWindow } from "electron";
import {
	browserViewManager,
	type TabStateSnapshot,
} from "main/lib/browser/browser-view-manager";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * v3 browser pane wiring. The renderer owns a placeholder div, reports
 * its bounding client rect, and the main process drives the
 * WebContentsView accordingly. Tab create / switch / close flow through
 * here; events (did-navigate, page-title-updated, fav updates, loading
 * flags, download events) are fanned out via `onTabs` /
 * `onTabState` subscriptions.
 */

const boundsSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});

export const createBrowserViewRouter = () => {
	return router({
		register: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					initialUrl: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const win =
					BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
				if (!win) throw new Error("No BrowserWindow available");
				browserViewManager.register(
					input.paneId,
					win,
					input.initialUrl ?? "about:blank",
				);
				return { success: true };
			}),

		unregister: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.unregister(input.paneId);
				return { success: true };
			}),

		setBounds: publicProcedure
			.input(z.object({ paneId: z.string(), bounds: boundsSchema }))
			.mutation(({ input }) => {
				browserViewManager.setBounds(input.paneId, input.bounds);
				return { success: true };
			}),

		createTab: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					url: z.string().default("about:blank"),
					activate: z.boolean().default(true),
				}),
			)
			.mutation(({ input }) => {
				const tabId = browserViewManager.createTab(
					input.paneId,
					input.url,
					input.activate,
				);
				return { tabId };
			}),

		closeTab: publicProcedure
			.input(z.object({ paneId: z.string(), tabId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.closeTab(input.paneId, input.tabId);
				return { success: true };
			}),

		activateTab: publicProcedure
			.input(z.object({ paneId: z.string(), tabId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.activateTab(input.paneId, input.tabId);
				return { success: true };
			}),

		navigate: publicProcedure
			.input(z.object({ paneId: z.string(), url: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.navigate(input.paneId, input.url);
				return { success: true };
			}),

		goBack: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.goBack(input.paneId);
				return { success: true };
			}),

		goForward: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.goForward(input.paneId);
				return { success: true };
			}),

		reload: publicProcedure
			.input(z.object({ paneId: z.string(), hard: z.boolean().optional() }))
			.mutation(({ input }) => {
				browserViewManager.reload(input.paneId, input.hard === true);
				return { success: true };
			}),

		setSuspended: publicProcedure
			.input(z.object({ paneId: z.string(), suspended: z.boolean() }))
			.mutation(({ input }) => {
				browserViewManager.setSuspended(input.paneId, input.suspended);
				return { success: true };
			}),

		onTabs: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{
					activeTabId: string;
					tabs: TabStateSnapshot[];
				}>((emit) => {
					const handler = (data: {
						activeTabId: string;
						tabs: TabStateSnapshot[];
					}) => emit.next(data);
					browserViewManager.on(`tabs:${input.paneId}`, handler);
					// Prime
					emit.next({
						activeTabId:
							browserViewManager.getActiveTabId(input.paneId) ?? "primary",
						tabs: browserViewManager.listTabs(input.paneId),
					});
					return () => {
						browserViewManager.off(`tabs:${input.paneId}`, handler);
					};
				});
			}),

		onDownload: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{
					filename: string;
					targetPath: string;
					url: string;
				}>((emit) => {
					const handler = (data: {
						filename: string;
						targetPath: string;
						url: string;
					}) => emit.next(data);
					browserViewManager.on(`download-started:${input.paneId}`, handler);
					return () => {
						browserViewManager.off(`download-started:${input.paneId}`, handler);
					};
				});
			}),
	});
};
