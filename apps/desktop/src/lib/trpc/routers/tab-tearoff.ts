import type { WindowManager } from "main/lib/window-manager";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { loadToken } from "./auth/utils/auth-functions";

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
			.mutation(async ({ input }) => {
				const windowId = `tearoff-${Date.now()}`;

				// Store data FIRST so it's available when preload requests it
				wm.setPendingTearoffData(windowId, {
					tab: input.tab,
					panes: input.panes,
					workspaceId: input.workspaceId,
				});

				// Pre-load auth token so tearoff window can skip async auth hydration
				const { token, expiresAt } = await loadToken();
				wm.setPendingAuthToken(
					windowId,
					token && expiresAt ? { token, expiresAt } : null,
				);

				wm.createTearoffWindow({
					windowId,
					screenX: input.screenX,
					screenY: input.screenY,
				});

				return { windowId };
			}),
	});
};
