let native;
let loadError = null;
try {
	native = require("./build/Release/macos_window_blur.node");
	console.log(
		"[macos-window-blur] native addon loaded successfully",
		typeof native.setWindowBlurRadius,
	);
} catch (error) {
	// Non-macOS, or native build was skipped — fall back gracefully.
	native = null;
	loadError = error;
	console.warn("[macos-window-blur] failed to load native addon:", error);
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
	if (!isNativeBlurAvailable()) {
		console.log("[macos-window-blur] setWindowBlurRadius: addon unavailable", {
			native: Boolean(native),
			loadError: loadError?.message,
		});
		return false;
	}
	if (!Buffer.isBuffer(handle)) {
		console.log("[macos-window-blur] invalid handle (not a Buffer)");
		return false;
	}
	if (typeof radius !== "number" || Number.isNaN(radius)) {
		console.log("[macos-window-blur] invalid radius:", radius);
		return false;
	}
	try {
		const ok = Boolean(native.setWindowBlurRadius(handle, radius));
		console.log(
			`[macos-window-blur] setWindowBlurRadius(radius=${radius}) -> ${ok}`,
		);
		return ok;
	} catch (error) {
		console.warn("[macos-window-blur] setWindowBlurRadius failed:", error);
		return false;
	}
}

module.exports = { isNativeBlurAvailable, setWindowBlurRadius };
