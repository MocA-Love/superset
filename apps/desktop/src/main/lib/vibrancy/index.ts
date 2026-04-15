import {
	isNativeBlurAvailable,
	setWindowBlurRadius,
} from "@superset/macos-window-blur";
import type { BrowserWindow } from "electron";
import { PLATFORM } from "shared/constants";
import {
	DEFAULT_VIBRANCY_STATE,
	VIBRANCY_BLUR_RADIUS_MAX,
	VIBRANCY_BLUR_RADIUS_MIN,
	VIBRANCY_OPACITY_MAX,
	VIBRANCY_OPACITY_MIN,
	type VibrancyBlurLevel,
	type VibrancyState,
} from "shared/vibrancy-types";

export {
	DEFAULT_VIBRANCY_STATE,
	type VibrancyBlurLevel,
	type VibrancyState,
} from "shared/vibrancy-types";

const BLUR_TO_ELECTRON_VIBRANCY: Record<
	VibrancyBlurLevel,
	"sidebar" | "header" | "content" | "fullscreen-ui"
> = {
	subtle: "sidebar",
	standard: "header",
	strong: "content",
	ultra: "fullscreen-ui",
};

// Ember dark / Superset light background colors used when vibrancy is off.
const OPAQUE_DARK = "#151110";
const OPAQUE_LIGHT = "#ffffff";

const DARK_RGB = { r: 21, g: 17, b: 16 };
const LIGHT_RGB = { r: 255, g: 255, b: 255 };

export function isVibrancySupported(): boolean {
	return PLATFORM.IS_MAC;
}

/**
 * Clamp opacity to the supported range defined in shared/vibrancy-types.
 */
export function normalizeVibrancyState(
	partial: Partial<VibrancyState>,
	base: VibrancyState = DEFAULT_VIBRANCY_STATE,
): VibrancyState {
	const opacity =
		partial.opacity === undefined
			? base.opacity
			: Math.max(
					VIBRANCY_OPACITY_MIN,
					Math.min(VIBRANCY_OPACITY_MAX, Math.round(partial.opacity)),
				);
	const blurLevel: VibrancyBlurLevel =
		partial.blurLevel && partial.blurLevel in BLUR_TO_ELECTRON_VIBRANCY
			? partial.blurLevel
			: base.blurLevel;
	const blurRadius =
		partial.blurRadius === undefined
			? base.blurRadius
			: Math.max(
					VIBRANCY_BLUR_RADIUS_MIN,
					Math.min(VIBRANCY_BLUR_RADIUS_MAX, Math.round(partial.blurRadius)),
				);
	return {
		enabled: partial.enabled ?? base.enabled,
		opacity,
		blurLevel,
		blurRadius,
	};
}

/**
 * Whether the native CIGaussianBlur addon loaded successfully on this
 * machine. When false, the vibrancy slider UI should fall back to the
 * four-step blurLevel selection.
 */
export function isNativeContinuousBlurSupported(): boolean {
	return isVibrancySupported() && isNativeBlurAvailable();
}

function toHexAlpha(opacityPercent: number): string {
	const alpha = Math.round((opacityPercent / 100) * 255);
	return alpha.toString(16).padStart(2, "0");
}

/**
 * Build an #RRGGBBAA color string using the current theme brightness and the
 * vibrancy opacity slider. `opacity` here means "how transparent the chrome
 * becomes when vibrancy is active" — 0 = fully see-through, 100 = opaque.
 *
 * When vibrancy is disabled we return a fully opaque color so the window
 * renders identically to the pre-vibrancy build.
 */
export function computeBackgroundColor(
	state: VibrancyState,
	isDark: boolean,
): string {
	if (!state.enabled) {
		return isDark ? OPAQUE_DARK : OPAQUE_LIGHT;
	}
	const rgb = isDark ? DARK_RGB : LIGHT_RGB;
	// Slider 100 = opaque; lower values = more transparent so desktop shows through.
	const alphaHex = toHexAlpha(state.opacity);
	const toHex = (n: number) => n.toString(16).padStart(2, "0");
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}${alphaHex}`;
}

export function resolveVibrancyType(
	state: VibrancyState,
): "sidebar" | "header" | "content" | "fullscreen-ui" | null {
	if (!state.enabled) return null;
	return BLUR_TO_ELECTRON_VIBRANCY[state.blurLevel];
}

/**
 * Apply the current vibrancy state to a BrowserWindow. Only has effect on
 * macOS — on other platforms this is a no-op so callers can invoke it
 * unconditionally.
 */
const VIBRANCY_DEBUG = Boolean(process.env.SUPERSET_VIBRANCY_DEBUG);

function vdbg(message: string, extra?: Record<string, unknown>): void {
	if (!VIBRANCY_DEBUG) return;
	console.log(`[vibrancy] ${message}`, extra ?? "");
}

export function applyVibrancy(
	window: BrowserWindow,
	state: VibrancyState,
	isDark: boolean,
): void {
	if (window.isDestroyed()) {
		vdbg("applyVibrancy skipped: window destroyed");
		return;
	}
	if (!isVibrancySupported()) {
		vdbg("applyVibrancy skipped: platform unsupported");
		return;
	}

	const vibrancyType = resolveVibrancyType(state);
	const backgroundColor = computeBackgroundColor(state, isDark);
	vdbg("applyVibrancy", {
		enabled: state.enabled,
		opacity: state.opacity,
		blurLevel: state.blurLevel,
		blurRadius: state.blurRadius,
		vibrancyType,
		backgroundColor,
		isDark,
	});

	window.setBackgroundColor(backgroundColor);
	// Electron's setVibrancy accepts null to disable since 6.x. When the
	// type annotation for a specific Electron version doesn't list `null`,
	// we pass the empty string fallback instead.
	if (vibrancyType === null) {
		window.setVibrancy(
			null as unknown as Parameters<BrowserWindow["setVibrancy"]>[0],
		);
	} else {
		window.setVibrancy(vibrancyType);
	}

	// Drive the native CIGaussianBlur filter on top of the NSVisualEffectView.
	// When the addon failed to load this is a no-op and we fall back to
	// whatever the selected material produces on its own.
	if (isNativeBlurAvailable()) {
		try {
			const handle = window.getNativeWindowHandle();
			const radius = state.enabled ? state.blurRadius : 0;
			const ok = setWindowBlurRadius(handle, radius);
			vdbg("setWindowBlurRadius returned", { ok, radius });
		} catch (error) {
			console.warn("[vibrancy] setWindowBlurRadius failed:", error);
		}
	} else {
		vdbg("native blur unavailable — skipping setWindowBlurRadius");
	}
}

/**
 * Options that callers should spread into the BrowserWindow constructor on
 * macOS so that vibrancy can later be toggled dynamically via
 * `setVibrancy` / `setBackgroundColor` without recreating the window.
 *
 * `transparent: true` is required at construction time — it cannot be
 * toggled later — so we always opt in on macOS even when the user has
 * vibrancy disabled. The opaque background color we set keeps the window
 * visually identical to the pre-vibrancy build until the user enables it.
 */
export function getInitialWindowOptions(
	state: VibrancyState,
	isDark: boolean,
): {
	transparent?: boolean;
	vibrancy?: "sidebar" | "header" | "content" | "fullscreen-ui";
	visualEffectState?: "followWindow" | "active" | "inactive";
	backgroundColor: string;
} {
	if (!isVibrancySupported()) {
		return {
			backgroundColor: isDark ? OPAQUE_DARK : OPAQUE_LIGHT,
		};
	}

	const vibrancyType = resolveVibrancyType(state);
	const backgroundColor = computeBackgroundColor(state, isDark);

	if (vibrancyType === null) {
		// Vibrancy disabled: still opt into transparent so we can toggle later
		// without recreating the window. Background color is fully opaque.
		return {
			transparent: true,
			visualEffectState: "active",
			backgroundColor,
		};
	}

	return {
		transparent: true,
		vibrancy: vibrancyType,
		visualEffectState: "active",
		backgroundColor,
	};
}
