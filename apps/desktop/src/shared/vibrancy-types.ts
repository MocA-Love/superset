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
}

export const DEFAULT_VIBRANCY_STATE: VibrancyState = {
	enabled: false,
	opacity: 60,
	blurLevel: "standard",
};

/** Lower bound matched by the settings slider. Keep in sync with UI. */
export const VIBRANCY_OPACITY_MIN = 10;
export const VIBRANCY_OPACITY_MAX = 100;
