import type { BrowserWindow } from "electron";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	getExtensionsWithToolbarInfo,
	installExtension,
	listExtensions,
	toggleExtension,
	uninstallExtension,
} from "main/lib/extensions/extension-manager";
import { extensionPopupManager } from "main/lib/extensions/extension-popup-manager";

export const createExtensionsRouter = (
	getWindow: () => BrowserWindow | null,
) => {
	return router({
		list: publicProcedure.query(async () => {
			return listExtensions();
		}),

		install: publicProcedure
			.input(z.object({ input: z.string() }))
			.mutation(async ({ input }) => {
				return installExtension(input.input);
			}),

		uninstall: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				await uninstallExtension(input.extensionId);
			}),

		toggle: publicProcedure
			.input(z.object({ extensionId: z.string(), enabled: z.boolean() }))
			.mutation(async ({ input }) => {
				return toggleExtension(input.extensionId, input.enabled);
			}),

		listToolbarExtensions: publicProcedure.query(async () => {
			return getExtensionsWithToolbarInfo();
		}),

		openPopup: publicProcedure
			.input(
				z.object({
					extensionId: z.string(),
					popupPath: z.string(),
					anchorRect: z.object({
						x: z.number(),
						y: z.number(),
						width: z.number(),
						height: z.number(),
					}),
				}),
			)
			.mutation(({ input }) => {
				const window = getWindow();
				if (!window) return { success: false };
				extensionPopupManager.openPopup(
					window,
					input.extensionId,
					input.popupPath,
					input.anchorRect,
				);
				return { success: true };
			}),

		closePopup: publicProcedure.mutation(() => {
			extensionPopupManager.closePopup();
			return { success: true };
		}),
	});
};
