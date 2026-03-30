import type { WindowManager } from "main/lib/window-manager";
import { z } from "zod";
import { publicProcedure, router } from "..";

export const createTabTearoffRouter = (wm: WindowManager) => {
	return router({
		create: publicProcedure
			.input(
				z.object({
					tab: z.unknown(),
					panes: z.record(z.string(), z.unknown()),
					workspaceId: z.string(),
					screenX: z.number(),
					screenY: z.number(),
				}),
			)
			.mutation(({ input }) => {
				const windowId = `tearoff-${Date.now()}`;

				// Store data FIRST so it's available when preload requests it
				wm.setPendingTearoffData(windowId, {
					tab: input.tab,
					panes: input.panes,
					workspaceId: input.workspaceId,
				});

				wm.createTearoffWindow({
					windowId,
					screenX: input.screenX,
					screenY: input.screenY,
				});

				return { windowId };
			}),
	});
};
