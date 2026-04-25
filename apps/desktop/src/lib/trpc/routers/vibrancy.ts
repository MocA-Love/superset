import { observable } from "@trpc/server/observable";
import { nativeTheme } from "electron";
import { appState } from "main/lib/app-state";
import {
	applyVibrancy,
	DEFAULT_VIBRANCY_STATE,
	getBootTransparent,
	isNativeContinuousBlurSupported,
	isVibrancySupported,
	normalizeVibrancyState,
	type VibrancyBlurLevel,
	type VibrancyState,
} from "main/lib/vibrancy";
import { VIBRANCY_EVENTS, vibrancyEmitter } from "main/lib/vibrancy/emitter";
import type { WindowManager } from "main/lib/window-manager";
import { PLATFORM } from "shared/constants";
import { z } from "zod";
import { publicProcedure, router } from "..";

type VibrancyPlatform = "mac" | "windows" | "linux" | "unsupported";

function getVibrancyPlatform(): VibrancyPlatform {
	if (PLATFORM.IS_MAC) return "mac";
	if (PLATFORM.IS_WINDOWS) return "windows";
	if (PLATFORM.IS_LINUX) return "linux";
	return "unsupported";
}

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
	blurRadius: z.number().min(0).max(100).optional(),
});

function getCurrentState(): VibrancyState {
	const stored = appState.data?.vibrancyState;
	// Merge over defaults so older on-disk states (written before we added
	// blurRadius) still produce a complete VibrancyState. Otherwise the
	// missing field would round-trip as `undefined` and the slider would
	// appear to reset on every restart.
	return { ...DEFAULT_VIBRANCY_STATE, ...stored };
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
			return {
				supported: isVibrancySupported(),
				nativeBlurSupported: isNativeContinuousBlurSupported(),
				platform: getVibrancyPlatform(),
				// Whether the main window was constructed with `transparent: true`
				// at this app launch. macOS is always true; Windows/Linux match
				// the persisted enabled state at startup. Renderer compares this
				// against the live state to decide whether toggling vibrancy
				// requires an app restart to fully take effect.
				bootTransparent: getBootTransparent(),
			};
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
