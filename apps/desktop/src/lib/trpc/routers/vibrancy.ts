import { observable } from "@trpc/server/observable";
import { nativeTheme } from "electron";
import { appState } from "main/lib/app-state";
import {
	applyVibrancy,
	DEFAULT_VIBRANCY_STATE,
	isVibrancySupported,
	normalizeVibrancyState,
	type VibrancyBlurLevel,
	type VibrancyState,
} from "main/lib/vibrancy";
import { VIBRANCY_EVENTS, vibrancyEmitter } from "main/lib/vibrancy/emitter";
import type { WindowManager } from "main/lib/window-manager";
import { z } from "zod";
import { publicProcedure, router } from "..";

const blurLevelSchema: z.ZodType<VibrancyBlurLevel> = z.enum([
	"subtle",
	"standard",
	"strong",
	"ultra",
]);

const vibrancyInputSchema = z.object({
	enabled: z.boolean().optional(),
	opacity: z.number().int().min(0).max(100).optional(),
	blurLevel: blurLevelSchema.optional(),
});

function getCurrentState(): VibrancyState {
	return appState.data?.vibrancyState ?? DEFAULT_VIBRANCY_STATE;
}

async function writeState(next: VibrancyState): Promise<void> {
	if (!appState.data) return;
	appState.data.vibrancyState = next;
	await appState.write();
}

function broadcastVibrancy(wm: WindowManager, state: VibrancyState): void {
	const isDark = nativeTheme.shouldUseDarkColors;
	for (const window of wm.getAll().values()) {
		applyVibrancy(window, state, isDark);
	}
}

export const createVibrancyRouter = (wm: WindowManager) => {
	return router({
		getSupported: publicProcedure.query(() => {
			return { supported: isVibrancySupported() };
		}),

		get: publicProcedure.query(() => {
			return getCurrentState();
		}),

		set: publicProcedure
			.input(vibrancyInputSchema)
			.mutation(async ({ input }) => {
				const current = getCurrentState();
				const next = normalizeVibrancyState(input, current);
				await writeState(next);
				broadcastVibrancy(wm, next);
				vibrancyEmitter.emit(VIBRANCY_EVENTS.CHANGED, next);
				return next;
			}),

		onChanged: publicProcedure.subscription(() => {
			return observable<VibrancyState>((emit) => {
				const handler = (state: VibrancyState) => {
					emit.next(state);
				};
				vibrancyEmitter.on(VIBRANCY_EVENTS.CHANGED, handler);
				return () => {
					vibrancyEmitter.off(VIBRANCY_EVENTS.CHANGED, handler);
				};
			});
		}),
	});
};

export type VibrancyRouter = ReturnType<typeof createVibrancyRouter>;
