/**
 * macOS-only native addon that attaches a CIGaussianBlur filter to the
 * NSVisualEffectView that Electron's `BrowserWindow.vibrancy` inserts,
 * giving us a continuous blur-radius slider instead of the four fixed
 * NSVisualEffectView material presets.
 */

export function isNativeBlurAvailable(): boolean;

export function setWindowBlurRadius(handle: Buffer, radius: number): boolean;
