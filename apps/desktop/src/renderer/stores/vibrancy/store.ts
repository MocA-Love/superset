import type { ITheme } from "@xterm/xterm";
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

function hexToRgba(hex: string, alpha: number): string | null {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return null;
	const digits = match[1];
	if (!digits) return null;
	let r: number;
	let g: number;
	let b: number;
	if (digits.length === 3) {
		r = Number.parseInt(`${digits[0]}${digits[0]}`, 16);
		g = Number.parseInt(`${digits[1]}${digits[1]}`, 16);
		b = Number.parseInt(`${digits[2]}${digits[2]}`, 16);
	} else {
		r = Number.parseInt(digits.slice(0, 2), 16);
		g = Number.parseInt(digits.slice(2, 4), 16);
		b = Number.parseInt(digits.slice(4, 6), 16);
	}
	return `rgba(${r}, ${g}, ${b}, ${clampAlpha(alpha).toFixed(3)})`;
}

/**
 * Hook consumed by the terminal pane. Returns the theme as-is when
 * vibrancy is off, and a translucent-background variant when vibrancy
 * is on so the xterm canvas blends into the window's vibrancy layer.
 */
export function useEffectiveTerminalTheme(): ITheme | null {
	const base = useThemeStore((s) => s.terminalTheme);
	const enabled = useVibrancyStore((s) => s.enabled);
	const opacity = useVibrancyStore((s) => s.opacity);
	if (!base || !enabled) return base;
	const bg = base.background;
	if (typeof bg !== "string") return base;
	const rgba = hexToRgba(bg, opacity / 100);
	if (!rgba) return base;
	return { ...base, background: rgba };
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
