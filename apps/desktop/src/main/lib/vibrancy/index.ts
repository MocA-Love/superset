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
export function applyVibrancy(
	window: BrowserWindow,
	state: VibrancyState,
	isDark: boolean,
): void {
	if (window.isDestroyed()) return;
	if (!isVibrancySupported()) return;

	const vibrancyType = resolveVibrancyType(state);
	const backgroundColor = computeBackgroundColor(state, isDark);

	window.setBackgroundColor(backgroundColor);
	// Electron's setVibrancy accepts `null` to clear the effect — the type
	// definition in Electron 30+ includes `string | null`, so the value
	// returned by resolveVibrancyType can be passed through directly.
	window.setVibrancy(vibrancyType);

	scheduleNativeBlur(window, state);
}

// --- Native blur scheduling ----------------------------------------------
// Each window tracks the "latest requested radius" plus a list of pending
// retry timers. When a new applyVibrancy call arrives we:
//   1. Update the latest radius for that window
//   2. Cancel any still-pending retries from older calls
//   3. Schedule a fresh burst of retries that all read from `latestRadius`
// This kills a subtle race where a user dragging the blur slider quickly
// would have an old value's 180ms retry land after a newer value was
// already applied, clobbering it.

interface BlurSchedule {
	latestRadius: number;
	timers: ReturnType<typeof setTimeout>[];
}

const blurSchedules = new WeakMap<BrowserWindow, BlurSchedule>();

function scheduleNativeBlur(window: BrowserWindow, state: VibrancyState): void {
	if (!isNativeBlurAvailable()) return;

	const radius = state.enabled ? state.blurRadius : 0;
	let schedule = blurSchedules.get(window);
	if (!schedule) {
		schedule = { latestRadius: radius, timers: [] };
		blurSchedules.set(window, schedule);
	} else {
		schedule.latestRadius = radius;
		for (const timer of schedule.timers) clearTimeout(timer);
		schedule.timers.length = 0;
	}

	const handle = window.getNativeWindowHandle();
	const apply = (): void => {
		if (window.isDestroyed()) return;
		const current = blurSchedules.get(window);
		if (!current) return;
		try {
			setWindowBlurRadius(handle, current.latestRadius);
		} catch (error) {
			console.warn("[vibrancy] setWindowBlurRadius failed:", error);
		}
	};

	// Immediate apply + retries that stretch long enough to beat the
	// NSVisualEffectView's own lazy refresh cycle.
	apply();
	const delays = [16, 64, 180, 480, 960];
	for (const delay of delays) {
		const timer = setTimeout(() => {
			if (!schedule) return;
			const index = schedule.timers.indexOf(timer);
			if (index >= 0) schedule.timers.splice(index, 1);
			apply();
		}, delay);
		schedule.timers.push(timer);
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
