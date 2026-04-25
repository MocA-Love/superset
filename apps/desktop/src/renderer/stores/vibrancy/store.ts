import type { ITheme } from "@xterm/xterm";
import { useMemo } from "react";
import type { Theme } from "shared/themes";
import {
	DEFAULT_VIBRANCY_STATE,
	type VibrancyState,
} from "shared/vibrancy-types";
import { create } from "zustand";
import { setRgbTransparencyForVibrancy } from "../../lib/terminal/webgl-vibrancy-patch";
import { electronTrpcClient } from "../../lib/trpc-client";
import { useThemeStore } from "../theme";
import { applyUIColors } from "../theme/utils";

interface VibrancyStore extends VibrancyState {
	supported: boolean;
	nativeBlurSupported: boolean;
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
 * Hook consumed by the terminal pane. Returns the theme as-is when
 * vibrancy is off. When vibrancy is on, the xterm background is forced
 * to fully transparent so the window's vibrancy layer is the single
 * source of tint — matching how `--background` is handled for the rest
 * of the app. Any non-zero alpha here would stack on top of the window
 * tint and make the terminal pane visibly darker than surrounding UI.
 *
 * Earlier iterations also overrode `theme.black` / `theme.brightBlack`
 * to transparent so palette-bg cells (codex's `\x1b[40m` etc.) would
 * also drop out. Two reasons we don't anymore:
 *   1. codex / Claude Code paint with truecolor `\x1b[48;2;…m`, not
 *      palette indices, so the override produced zero benefit (debug
 *      stats showed `cmP16P256Transparent: 0`). The CM_RGB brightness
 *      heuristic in `lib/terminal/webgl-vibrancy-patch.ts` is what
 *      actually catches their overlay blocks.
 *   2. The TextureAtlas forces foreground glyphs through `color.opaque`
 *      (`TextureAtlas.ts:357-359`), which turns a transparent
 *      `theme.brightBlack` into a *solid black* foreground. That broke
 *      shell autosuggestions and other dim-grey UI text that uses
 *      palette index 8 for its color.
 */
export function useEffectiveTerminalTheme(): ITheme | null {
	const base = useThemeStore((s) => s.terminalTheme);
	const enabled = useVibrancyStore((s) => s.enabled);
	return useMemo(() => {
		if (!base || !enabled) return base;
		return { ...base, background: "rgba(0, 0, 0, 0)" };
	}, [base, enabled]);
}

/**
 * Overlay the translucent color variables inline so they win the cascade
 * against the theme store's own inline writes (applyUIColors). Without this
 * overlay, toggling vibrancy does nothing visible because the theme store
 * already pinned the solid colors to `documentElement.style`.
 */
function applyVibrancyOverlay(theme: Theme, alpha: number): void {
	const root = document.documentElement;
	const set = (cssVar: string, base: string | undefined, a: number): void => {
		if (!base) return;
		root.style.setProperty(cssVar, toAlphaColor(base, clampAlpha(a)));
	};

	// The main --background is intentionally set to `transparent` (not
	// rgba with low alpha). The window itself is already tinted via
	// BrowserWindow.setBackgroundColor(rgba) on top of the NSVisualEffectView,
	// so if we made --background semi-transparent as well, every nested
	// `bg-background` container would multiply the tint and create visibly
	// darker rectangles where the UI stacks panes inside each other.
	// Letting the web content be fully transparent means the window
	// chrome is the single source of truth for the base color.
	root.style.setProperty("--background", "transparent");

	// Chrome surfaces keep a tint so they stand out from the transparent
	// body. We bias them slightly more opaque than the raw alpha so
	// sidebars/cards are still legible at low opacity settings.
	const chromeAlpha = clampAlpha(alpha + 0.15);
	set("--card", theme.ui.card, chromeAlpha);
	set("--muted", theme.ui.muted, chromeAlpha);
	set("--accent", theme.ui.accent, chromeAlpha);
	set("--sidebar", theme.ui.sidebar, chromeAlpha);
	set("--sidebar-accent", theme.ui.sidebarAccent, chromeAlpha);
	set("--tertiary", theme.ui.tertiary, chromeAlpha);
	set("--tertiary-active", theme.ui.tertiaryActive, chromeAlpha);
	if (theme.ui.popover) {
		// Popovers / menus stay near-opaque so text remains readable.
		root.style.setProperty("--popover", toAlphaColor(theme.ui.popover, 0.95));
	}
}

function applyToDom(state: VibrancyState): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.dataset.vibrancy = state.enabled ? "on" : "off";
	root.style.setProperty("--vibrancy-alpha", (state.opacity / 100).toFixed(3));

	// Toggle the brightness-threshold heuristic for explicit-RGB cells in the
	// xterm WebGL renderer (see `webgl-vibrancy-patch.ts`). codex / Claude Code
	// emit `\x1b[48;2;r;g;b m` for their overlay blocks, and those bypass the
	// theme.ansi[] alpha trick used for palette colors.
	setRgbTransparencyForVibrancy(state.enabled);

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
	nativeBlurSupported: false,
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
					nativeBlurSupported: supportInfo.nativeBlurSupported,
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
			blurRadius: partial.blurRadius ?? current.blurRadius,
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
