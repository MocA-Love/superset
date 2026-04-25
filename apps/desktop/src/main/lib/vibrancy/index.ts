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
	// macOS uses NSVisualEffectView. Windows 11 22H2+ uses Acrylic via
	// BrowserWindow.setBackgroundMaterial (gives a real see-through blurred
	// translucency, unlike Mica which is more of a desktop-color tint).
	// Linux uses pure transparency — actual background blur depends on the
	// active compositor (KDE KWin: yes, GNOME Shell: no, Wayland varies).
	return PLATFORM.IS_MAC || PLATFORM.IS_WINDOWS || PLATFORM.IS_LINUX;
}

/**
 * Whether the platform supports a system-level blur material behind the
 * window. macOS always does (NSVisualEffectView). Windows 11 22H2+ does via
 * acrylic. Linux varies per compositor and we don't gate the feature on it,
 * so callers that care should treat Linux as "no system blur, transparent
 * pixels only".
 */
export function hasSystemBlurMaterial(): boolean {
	return PLATFORM.IS_MAC || PLATFORM.IS_WINDOWS;
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
 * four-step blurLevel selection. macOS only — Windows Mica is a binary
 * on/off material, not a blur radius.
 */
export function isNativeContinuousBlurSupported(): boolean {
	return PLATFORM.IS_MAC && isNativeBlurAvailable();
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
 * Apply the current vibrancy state to a BrowserWindow. Routes to the right
 * platform-specific path; safe to call on unsupported platforms (no-op).
 */
export function applyVibrancy(
	window: BrowserWindow,
	state: VibrancyState,
	isDark: boolean,
): void {
	if (window.isDestroyed()) return;
	if (!isVibrancySupported()) return;

	if (PLATFORM.IS_WINDOWS) {
		applyWindowsBackgroundMaterial(window, state, isDark);
		return;
	}

	if (PLATFORM.IS_LINUX) {
		applyLinuxTransparency(window, state, isDark);
		return;
	}

	const vibrancyType = resolveVibrancyType(state);
	const backgroundColor = computeBackgroundColor(state, isDark);

	window.setBackgroundColor(backgroundColor);
	// Electron's setVibrancy accepts `null` to clear the effect — the type
	// definition in Electron 30+ includes `string | null`, so the value
	// returned by resolveVibrancyType can be passed through directly.
	window.setVibrancy(vibrancyType);

	scheduleNativeBlur(window, state);
}

/**
 * Windows 11 22H2+ uses Acrylic for actual see-through translucency
 * (Mica is more of a binary "desktop color tint" effect). On older Windows
 * versions setBackgroundMaterial silently no-ops and the rgba backgroundColor
 * still makes the window translucent because we created it with
 * `transparent: true`.
 */
function applyWindowsBackgroundMaterial(
	window: BrowserWindow,
	state: VibrancyState,
	isDark: boolean,
): void {
	type WithSetBackgroundMaterial = BrowserWindow & {
		setBackgroundMaterial?: (
			material: "auto" | "none" | "mica" | "acrylic" | "tabbed",
		) => void;
	};
	const withMaterial = window as WithSetBackgroundMaterial;
	try {
		withMaterial.setBackgroundMaterial?.(state.enabled ? "acrylic" : "none");
	} catch (error) {
		console.warn("[vibrancy] setBackgroundMaterial failed on Windows:", error);
	}
	// Pass the rgba value through so the slider's opacity reaches the
	// composited window. With `transparent: true` set at construction, this
	// produces a real translucent surface even when acrylic is unavailable
	// (older Win10 / Win11 pre-22H2).
	window.setBackgroundColor(computeBackgroundColor(state, isDark));
}

/**
 * Linux has no equivalent of NSVisualEffectView/Acrylic in Electron — there's
 * no setVibrancy or setBackgroundMaterial path. We rely entirely on
 * `transparent: true` at window creation plus an rgba backgroundColor here.
 * Whether the user sees a blur behind the window depends on their compositor:
 *   - KDE Plasma (KWin): blur via the Blur effect, can read window hints.
 *   - GNOME Shell: no app-controllable blur — the window will look like a
 *     simple translucent overlay.
 *   - Wayland: per-compositor, generally same as above.
 */
function applyLinuxTransparency(
	window: BrowserWindow,
	state: VibrancyState,
	isDark: boolean,
): void {
	window.setBackgroundColor(computeBackgroundColor(state, isDark));
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
 * Tracks whether the *first* window built in this app launch was constructed
 * with `transparent: true`. macOS always is (NSVisualEffectView is well-tested
 * and we want runtime toggles to "just work"); Windows/Linux are gated to the
 * vibrancy-enabled path because Electron's transparent windows on those
 * platforms have known interaction quirks (resize/maximize, GPU compositing)
 * that we don't want to inflict on users who never opted into vibrancy.
 *
 * Renderer reads this via the tRPC support query and, on Win/Linux, compares
 * against the live `state.enabled` to decide whether to surface a "restart
 * required" hint when the user toggles vibrancy after launch.
 */
let bootTransparent: boolean | null = null;

export function getBootTransparent(): boolean | null {
	return bootTransparent;
}

/**
 * Options that callers spread into the BrowserWindow constructor.
 *
 * `transparent: true` cannot be toggled at runtime — it has to be decided at
 * construction. macOS always opts in so that turning vibrancy on/off after
 * launch is a no-restart operation; on Windows/Linux we only opt in when
 * vibrancy is already enabled at startup so unrelated users don't pay the
 * transparent-window cost (Electron docs note reduced resize/maximize support
 * for transparent windows on these platforms). Toggling vibrancy after launch
 * therefore requires an app restart on Win/Linux to actually let pixels through.
 */
export function getInitialWindowOptions(
	state: VibrancyState,
	isDark: boolean,
): {
	transparent?: boolean;
	vibrancy?: "sidebar" | "header" | "content" | "fullscreen-ui";
	visualEffectState?: "followWindow" | "active" | "inactive";
	backgroundMaterial?: "auto" | "none" | "mica" | "acrylic" | "tabbed";
	backgroundColor: string;
} {
	if (!isVibrancySupported()) {
		bootTransparent ??= false;
		return {
			backgroundColor: isDark ? OPAQUE_DARK : OPAQUE_LIGHT,
		};
	}

	if (PLATFORM.IS_WINDOWS) {
		const transparent = state.enabled;
		bootTransparent ??= transparent;
		return {
			...(transparent ? { transparent: true } : {}),
			backgroundMaterial: state.enabled ? "acrylic" : "none",
			backgroundColor: state.enabled
				? computeBackgroundColor(state, isDark)
				: isDark
					? OPAQUE_DARK
					: OPAQUE_LIGHT,
		};
	}

	if (PLATFORM.IS_LINUX) {
		const transparent = state.enabled;
		bootTransparent ??= transparent;
		return {
			...(transparent ? { transparent: true } : {}),
			backgroundColor: state.enabled
				? computeBackgroundColor(state, isDark)
				: isDark
					? OPAQUE_DARK
					: OPAQUE_LIGHT,
		};
	}

	bootTransparent ??= true;

	const backgroundColor = computeBackgroundColor(state, isDark);
	// Always attach NSVisualEffectView at construction time, even when the
	// user has vibrancy disabled. The opaque backgroundColor fully covers
	// the vibrancy layer while it's off, but having it already mounted
	// means the first OFF→ON toggle can just change setBackgroundColor's
	// alpha — no window recreation / restart required. Previously we only
	// attached vibrancy when enabled, which meant `setVibrancy` first-time
	// attachment wouldn't fully take effect until next launch.
	const vibrancyType =
		resolveVibrancyType(state) ?? BLUR_TO_ELECTRON_VIBRANCY[state.blurLevel];

	return {
		transparent: true,
		vibrancy: vibrancyType,
		visualEffectState: "active",
		backgroundColor,
	};
}
