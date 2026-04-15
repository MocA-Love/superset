/**
 * Pure types and constants for the vibrancy feature. Must stay Electron-free
 * so it can be imported from both main and renderer (via `shared/`) without
 * pulling the Electron runtime into renderer bundles or test harnesses.
 */

export type VibrancyBlurLevel = "subtle" | "standard" | "strong" | "ultra";

export interface VibrancyState {
	enabled: boolean;
	opacity: number;
	blurLevel: VibrancyBlurLevel;
	/**
	 * Continuous Gaussian blur radius (0-100) used by the native
	 * macos-window-blur addon. When the addon is unavailable this
	 * value is still persisted but the main process falls back to
	 * mapping it onto the four discrete NSVisualEffectView materials
	 * in `blurLevel`.
	 */
	blurRadius: number;
}

export const DEFAULT_VIBRANCY_STATE: VibrancyState = {
	enabled: false,
	opacity: 35,
	blurLevel: "standard",
	blurRadius: 40,
};

/** Lower bound matched by the settings slider. Keep in sync with UI. */
export const VIBRANCY_OPACITY_MIN = 10;
export const VIBRANCY_OPACITY_MAX = 100;
export const VIBRANCY_BLUR_RADIUS_MIN = 0;
export const VIBRANCY_BLUR_RADIUS_MAX = 100;
