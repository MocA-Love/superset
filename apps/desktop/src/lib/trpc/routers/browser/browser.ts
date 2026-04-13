import {
	SITE_PERMISSION_KINDS,
	SITE_PERMISSION_VALUES,
} from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import { session } from "electron";
import { requestMediaAccess } from "lib/electron/request-media-access";
import { browserManager } from "main/lib/browser/browser-manager";
import { browserSitePermissionManager } from "main/lib/browser/browser-site-permission-manager";
import { z } from "zod";
import { publicProcedure, router } from "../..";

export const createBrowserRouter = () => {
	return router({
		register: publicProcedure
			.input(z.object({ paneId: z.string(), webContentsId: z.number() }))
			.mutation(({ input }) => {
				browserManager.register(input.paneId, input.webContentsId);
				return { success: true };
			}),

		unregister: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserManager.unregister(input.paneId);
				return { success: true };
			}),

		navigate: publicProcedure
			.input(z.object({ paneId: z.string(), url: z.string() }))
			.mutation(({ input }) => {
				browserManager.navigate(input.paneId, input.url);
				return { success: true };
			}),

		goBack: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				const wc = browserManager.getWebContents(input.paneId);
				if (wc?.canGoBack()) wc.goBack();
				return { success: true };
			}),

		goForward: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				const wc = browserManager.getWebContents(input.paneId);
				if (wc?.canGoForward()) wc.goForward();
				return { success: true };
			}),

		reload: publicProcedure
			.input(z.object({ paneId: z.string(), hard: z.boolean().optional() }))
			.mutation(({ input }) => {
				const wc = browserManager.getWebContents(input.paneId);
				if (!wc) return { success: false };
				if (input.hard) {
					wc.reloadIgnoringCache();
				} else {
					wc.reload();
				}
				return { success: true };
			}),

		screenshot: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(async ({ input }) => {
				const base64 = await browserManager.screenshot(input.paneId);
				return { base64 };
			}),

		evaluateJS: publicProcedure
			.input(z.object({ paneId: z.string(), code: z.string() }))
			.mutation(async ({ input }) => {
				const result = await browserManager.evaluateJS(
					input.paneId,
					input.code,
				);
				return { result };
			}),

		getConsoleLogs: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => {
				return browserManager.getConsoleLogs(input.paneId);
			}),

		consoleStream: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{
					level: string;
					message: string;
					timestamp: number;
				}>((emit) => {
					const handler = (entry: {
						level: string;
						message: string;
						timestamp: number;
					}) => {
						emit.next(entry);
					};
					browserManager.on(`console:${input.paneId}`, handler);
					return () => {
						browserManager.off(`console:${input.paneId}`, handler);
					};
				});
			}),

		onNewWindow: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ url: string }>((emit) => {
					const handler = (url: string) => {
						emit.next({ url });
					};
					browserManager.on(`new-window:${input.paneId}`, handler);
					return () => {
						browserManager.off(`new-window:${input.paneId}`, handler);
					};
				});
			}),

		/** Global subscription for new-window events from any browser pane. */
		onAnyNewWindow: publicProcedure.subscription(() => {
			return observable<{ paneId: string; url: string }>((emit) => {
				const handler = (data: { paneId: string; url: string }) => {
					emit.next(data);
				};
				browserManager.on("new-window", handler);
				return () => {
					browserManager.off("new-window", handler);
				};
			});
		}),

		/** Global subscription for HTML5 fullscreen enter/leave from any browser pane. */
		onFullscreenChange: publicProcedure.subscription(() => {
			return observable<{ paneId: string; isFullscreen: boolean }>((emit) => {
				const handler = (data: { paneId: string; isFullscreen: boolean }) => {
					emit.next(data);
				};
				browserManager.on("fullscreen-change", handler);
				return () => {
					browserManager.off("fullscreen-change", handler);
				};
			});
		}),

		onContextMenuAction: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ action: string; url: string }>((emit) => {
					const handler = (data: { action: string; url: string }) => {
						emit.next(data);
					};
					browserManager.on(`context-menu-action:${input.paneId}`, handler);
					return () => {
						browserManager.off(`context-menu-action:${input.paneId}`, handler);
					};
				});
			}),

		openDevTools: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				browserManager.openDevTools(input.paneId);
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
				const requestId = browserManager.findInPage(input.paneId, input.text, {
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
				browserManager.stopFindInPage(
					input.paneId,
					input.action ?? "clearSelection",
				);
				return { success: true };
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
					}) => {
						emit.next(data);
					};
					browserManager.on(`found-in-page:${input.paneId}`, handler);
					return () => {
						browserManager.off(`found-in-page:${input.paneId}`, handler);
					};
				});
			}),

		onFindRequested: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ type: "open" | "escape" }>((emit) => {
					const openHandler = () => emit.next({ type: "open" });
					const escapeHandler = () => emit.next({ type: "escape" });
					browserManager.on(`find-requested:${input.paneId}`, openHandler);
					browserManager.on(`find-escape:${input.paneId}`, escapeHandler);
					return () => {
						browserManager.off(`find-requested:${input.paneId}`, openHandler);
						browserManager.off(`find-escape:${input.paneId}`, escapeHandler);
					};
				});
			}),

		setZoomLevel: publicProcedure
			.input(z.object({ paneId: z.string(), level: z.number() }))
			.mutation(({ input }) => {
				const wc = browserManager.getWebContents(input.paneId);
				if (!wc) return { success: false };
				wc.setZoomLevel(input.level);
				return { success: true };
			}),

		onZoomChanged: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{ zoomLevel: number }>((emit) => {
					let lastLevel: number | null = null;
					const interval = setInterval(() => {
						const wc = browserManager.getWebContents(input.paneId);
						if (!wc) return;
						const level = wc.getZoomLevel();
						if (level !== lastLevel) {
							lastLevel = level;
							emit.next({ zoomLevel: level });
						}
					}, 300);
					return () => clearInterval(interval);
				});
			}),

		getPageInfo: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => {
				const wc = browserManager.getWebContents(input.paneId);
				if (!wc) return null;
				return {
					url: wc.getURL(),
					title: wc.getTitle(),
					canGoBack: wc.canGoBack(),
					canGoForward: wc.canGoForward(),
					isLoading: wc.isLoading(),
				};
			}),

		getSitePermissions: publicProcedure
			.input(z.object({ url: z.string() }))
			.query(({ input }) => {
				return browserSitePermissionManager.getPermissionsForUrl(input.url);
			}),

		setSitePermission: publicProcedure
			.input(
				z.object({
					origin: z.string(),
					kind: z.enum(SITE_PERMISSION_KINDS),
					value: z.enum(SITE_PERMISSION_VALUES),
				}),
			)
			.mutation(async ({ input }) => {
				const sitePermissions = browserSitePermissionManager.setPermission(
					input.origin,
					input.kind,
					input.value,
				);

				const mediaAccess =
					input.value === "allow" ? await requestMediaAccess(input.kind) : null;

				return {
					...sitePermissions,
					mediaAccess,
				};
			}),

		resetSitePermissions: publicProcedure
			.input(z.object({ origin: z.string() }))
			.mutation(({ input }) => {
				browserSitePermissionManager.resetPermissions(input.origin);
				return { success: true };
			}),

		onSitePermissionRequested: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ input }) => {
				return observable<{
					paneId: string;
					origin: string;
					permissions: ("microphone" | "camera")[];
				}>((emit) => {
					const handler = (event: {
						paneId: string;
						origin: string;
						permissions: ("microphone" | "camera")[];
					}) => {
						emit.next(event);
					};
					browserSitePermissionManager.on(
						`permission-requested:${input.paneId}`,
						handler,
					);
					return () => {
						browserSitePermissionManager.off(
							`permission-requested:${input.paneId}`,
							handler,
						);
					};
				});
			}),

		clearBrowsingData: publicProcedure
			.input(
				z.object({
					type: z.enum(["cookies", "cache", "storage", "all"]),
				}),
			)
			.mutation(async ({ input }) => {
				const ses = session.fromPartition("persist:superset");
				switch (input.type) {
					case "cookies":
						await ses.clearStorageData({ storages: ["cookies"] });
						break;
					case "cache":
						await ses.clearCache();
						break;
					case "storage":
						await ses.clearStorageData({
							storages: ["localstorage", "indexdb"],
						});
						break;
					case "all":
						await ses.clearStorageData();
						await ses.clearCache();
						break;
				}
				return { success: true };
			}),
	});
};
