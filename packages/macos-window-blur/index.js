let native;
try {
	native = require("./build/Release/macos_window_blur.node");
} catch {
	// Non-macOS, or native build was skipped — fall back gracefully.
	native = null;
}

/**
 * Returns true when the native addon loaded successfully on this platform.
 * Callers should still gate their logic behind `process.platform === "darwin"`
 * because the binary is only ever built for macOS.
 */
function isNativeBlurAvailable() {
	return native !== null && typeof native.setWindowBlurRadius === "function";
}

/**
 * Attach (or remove) a CIGaussianBlur filter to a BrowserWindow's
 * NSVisualEffectView so the blur radius can be driven by a continuous
 * slider. Pass `radius = 0` to clear the override and let the system
 * material render normally.
 *
 * @param {Buffer} handle - return value of `BrowserWindow.getNativeWindowHandle()`
 * @param {number} radius - Gaussian blur radius in points (0-200)
 * @returns {boolean} true on success, false when the addon is unavailable
 *          or no NSVisualEffectView could be found in the window.
 */
function setWindowBlurRadius(handle, radius) {
	if (!isNativeBlurAvailable()) return false;
	if (!Buffer.isBuffer(handle)) return false;
	if (typeof radius !== "number" || Number.isNaN(radius)) return false;
	try {
		return Boolean(native.setWindowBlurRadius(handle, radius));
	} catch (error) {
		console.warn("[macos-window-blur] setWindowBlurRadius failed:", error);
		return false;
	}
}

module.exports = { isNativeBlurAvailable, setWindowBlurRadius };
