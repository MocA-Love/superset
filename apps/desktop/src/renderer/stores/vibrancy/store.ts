import type { Theme } from "shared/themes";
import {
	DEFAULT_VIBRANCY_STATE,
	type VibrancyState,
} from "shared/vibrancy-types";
import { create } from "zustand";
import { electronTrpcClient } from "../../lib/trpc-client";
import { useThemeStore } from "../theme";
import { applyUIColors } from "../theme/utils";

interface VibrancyStore extends VibrancyState {
	supported: boolean;
	hydrated: boolean;
	setState: (partial: Partial<VibrancyState>) => Promise<void>;
	previewOpacity: (opacity: number) => void;
	hydrate: () => Promise<void>;
}

function clampAlpha(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function toAlphaColor(base: string, alpha: number): string {
	const pct = Math.max(0, Math.min(100, alpha * 100));
	// color-mix works with hex, rgb, oklch, etc. — Chromium 111+.
	return `color-mix(in srgb, ${base} ${pct.toFixed(2)}%, transparent)`;
}

/**
 * Overlay the translucent color variables inline so they win the cascade
 * against the theme store's own inline writes (applyUIColors). Without this
 * overlay, toggling vibrancy does nothing visible because the theme store
 * already pinned the solid colors to `documentElement.style`.
 */
function applyVibrancyOverlay(theme: Theme, alpha: number): void {
	const root = document.documentElement;
	const set = (cssVar: string, base: string | undefined, delta = 0): void => {
		if (!base) return;
		const effective = clampAlpha(alpha + delta);
		root.style.setProperty(cssVar, toAlphaColor(base, effective));
	};

	set("--background", theme.ui.background);
	set("--card", theme.ui.card, 0.1);
	set("--muted", theme.ui.muted, 0.1);
	set("--accent", theme.ui.accent, 0.1);
	set("--sidebar", theme.ui.sidebar, -0.05);
	set("--sidebar-accent", theme.ui.sidebarAccent, 0.05);
	set("--tertiary", theme.ui.tertiary, -0.05);
	set("--tertiary-active", theme.ui.tertiaryActive, 0.05);
	// Popover stays mostly opaque so menus and toasts remain readable.
	if (theme.ui.popover) {
		root.style.setProperty("--popover", toAlphaColor(theme.ui.popover, 0.95));
	}
}

function applyToDom(state: VibrancyState): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.dataset.vibrancy = state.enabled ? "on" : "off";
	root.style.setProperty("--vibrancy-alpha", (state.opacity / 100).toFixed(3));

	const activeTheme = useThemeStore.getState().activeTheme;
	if (!activeTheme) return;

	if (state.enabled) {
		applyVibrancyOverlay(activeTheme, state.opacity / 100);
	} else {
		// Restore solid theme colors by reapplying the theme's own palette.
		applyUIColors(activeTheme.ui);
	}
}

let hydratePromise: Promise<void> | null = null;
let subscriptionEstablished = false;
let themeSubscriptionEstablished = false;

function ensureThemeSubscription(): void {
	if (themeSubscriptionEstablished) return;
	themeSubscriptionEstablished = true;
	// When the user changes theme while vibrancy is on, the theme store
	// reapplies solid colors and wipes our overlay — reapply it here.
	useThemeStore.subscribe((themeState, prevThemeState) => {
		if (themeState.activeTheme === prevThemeState.activeTheme) return;
		const vibrancy = useVibrancyStore.getState();
		if (vibrancy.supported && vibrancy.enabled) {
			applyToDom(vibrancy);
		}
	});
}

export const useVibrancyStore = create<VibrancyStore>()((set, get) => ({
	...DEFAULT_VIBRANCY_STATE,
	supported: false,
	hydrated: false,

	hydrate: async () => {
		// Guard against StrictMode double-invocation and concurrent callers by
		// caching the in-flight promise rather than relying on post-await state.
		if (get().hydrated) return;
		if (hydratePromise) return hydratePromise;

		hydratePromise = (async () => {
			try {
				const [current, supportInfo] = await Promise.all([
					electronTrpcClient.vibrancy.get.query(),
					electronTrpcClient.vibrancy.getSupported.query(),
				]);
				// Coerce to disabled on unsupported platforms so a state imported
				// from macOS (enabled: true) never leaks into the DOM on Win/Linux.
				const effective: VibrancyState = supportInfo.supported
					? current
					: { ...current, enabled: false };
				applyToDom(effective);
				set({
					...effective,
					supported: supportInfo.supported,
					hydrated: true,
				});
				ensureThemeSubscription();

				if (!subscriptionEstablished) {
					subscriptionEstablished = true;
					electronTrpcClient.vibrancy.onChanged.subscribe(undefined, {
						onData: (incoming) => {
							const isSupported = get().supported;
							const effectiveIncoming: VibrancyState = isSupported
								? incoming
								: { ...incoming, enabled: false };
							applyToDom(effectiveIncoming);
							set(effectiveIncoming);
						},
						onError: (err) => {
							console.error("[vibrancy] subscription error:", err);
							subscriptionEstablished = false;
						},
					});
				}
			} catch (error) {
				console.error("[vibrancy] Failed to hydrate store:", error);
				applyToDom(DEFAULT_VIBRANCY_STATE);
				// Allow retry on transient failures.
				hydratePromise = null;
			}
		})();

		return hydratePromise;
	},

	previewOpacity: (opacity) => {
		const current = get();
		if (!current.supported || !current.enabled) return;
		applyToDom({ ...current, opacity });
	},

	setState: async (partial) => {
		const current = get();
		const optimistic: VibrancyState = {
			enabled: partial.enabled ?? current.enabled,
			opacity: partial.opacity ?? current.opacity,
			blurLevel: partial.blurLevel ?? current.blurLevel,
		};
		applyToDom(optimistic);
		set(optimistic);
		try {
			const confirmed = await electronTrpcClient.vibrancy.set.mutate(partial);
			applyToDom(confirmed);
			set(confirmed);
		} catch (error) {
			console.error("[vibrancy] Failed to persist state:", error);
			applyToDom(current);
			set(current);
		}
	},
}));
