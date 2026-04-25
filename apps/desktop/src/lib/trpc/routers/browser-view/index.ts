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

		setHostVisibility: publicProcedure
			.input(z.object({ paneId: z.string(), visible: z.boolean() }))
			.mutation(({ input }) => {
				browserViewManager.setHostVisibility(input.paneId, input.visible);
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

		screenshot: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(async ({ input }) => {
				const base64 = await browserViewManager.screenshot(input.paneId);
				return { base64 };
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

		openDevTools: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserViewManager.openDevTools(input.paneId);
				return { success: true };
			}),

		findInPage: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					text: z.string(),
					forward: z.boolean().optional(),
					findNext: z.boolean().optional(),
					matchCase: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) => {
				const requestId = browserViewManager.findInPage(input.paneId, input.text, {
					forward: input.forward,
					findNext: input.findNext,
					matchCase: input.matchCase,
				});
				return { requestId };
			}),

		stopFindInPage: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					action: z
						.enum(["clearSelection", "keepSelection", "activateSelection"])
						.optional(),
				}),
			)
			.mutation(({ input }) => {
				browserViewManager.stopFindInPage(
					input.paneId,
					input.action ?? "clearSelection",
				);
				return { success: true };
			}),

		setZoomLevel: publicProcedure
			.input(z.object({ paneId: z.string(), level: z.number() }))
			.mutation(({ input }) => {
				return {
					success: browserViewManager.setZoomLevel(input.paneId, input.level),
				};
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

		onFoundInPage: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{
					requestId: number;
					activeMatchOrdinal: number;
					matches: number;
					finalUpdate: boolean;
				}>((emit) => {
					const handler = (data: {
						requestId: number;
						activeMatchOrdinal: number;
						matches: number;
						finalUpdate: boolean;
					}) => emit.next(data);
					browserViewManager.on(`found-in-page:${input.paneId}`, handler);
					return () => {
						browserViewManager.off(`found-in-page:${input.paneId}`, handler);
					};
				});
			}),

		onFindRequested: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ type: "open" | "escape" }>((emit) => {
					const openHandler = () => emit.next({ type: "open" });
					const escapeHandler = () => emit.next({ type: "escape" });
					browserViewManager.on(`find-requested:${input.paneId}`, openHandler);
					browserViewManager.on(`find-escape:${input.paneId}`, escapeHandler);
					return () => {
						browserViewManager.off(`find-requested:${input.paneId}`, openHandler);
						browserViewManager.off(`find-escape:${input.paneId}`, escapeHandler);
					};
				});
			}),

		onZoomChanged: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ zoomLevel: number }>((emit) => {
					let lastLevel: number | null = null;
					const interval = setInterval(() => {
						const level = browserViewManager.getZoomLevel(input.paneId);
						if (level === null || level === lastLevel) return;
						lastLevel = level;
						emit.next({ zoomLevel: level });
					}, 300);
					return () => clearInterval(interval);
				});
			}),
	});
};
