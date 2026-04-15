#include <napi.h>

#ifdef __APPLE__
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

/**
 * Walk the view hierarchy rooted at `root` looking for an NSVisualEffectView.
 * Electron inserts one of these to implement BrowserWindow's `vibrancy`
 * option, and we attach our CIGaussianBlur filter to its backing layer.
 */
static NSVisualEffectView* FindVisualEffectView(NSView* root) {
	if (!root) return nil;
	if ([root isKindOfClass:[NSVisualEffectView class]]) {
		return (NSVisualEffectView*)root;
	}
	for (NSView* child in root.subviews) {
		NSVisualEffectView* found = FindVisualEffectView(child);
		if (found) return found;
	}
	return nil;
}

static NSWindow* WindowFromNativeHandle(const Napi::Buffer<uint8_t>& handle) {
	if (handle.Length() != sizeof(void*)) return nil;
	void* raw = *reinterpret_cast<void**>(handle.Data());
	if (!raw) return nil;
	id obj = (__bridge id)raw;
	if ([obj isKindOfClass:[NSWindow class]]) {
		return (NSWindow*)obj;
	}
	if ([obj isKindOfClass:[NSView class]]) {
		return ((NSView*)obj).window;
	}
	return nil;
}
#endif

/**
 * setWindowBlurRadius(handle: Buffer, radius: number): boolean
 *
 * Attaches a CIGaussianBlur filter to the window's NSVisualEffectView layer
 * so the blur radius can be driven by a continuous slider instead of the
 * coarse NSVisualEffectView material presets. Pass radius = 0 to remove
 * the custom filter (restoring the system-provided material look).
 *
 * Returns true on success. Returns false on non-macOS platforms, when the
 * handle is invalid, or when no NSVisualEffectView was found in the
 * window's view hierarchy.
 */
Napi::Value SetWindowBlurRadius(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();

	if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
		Napi::TypeError::New(env,
			"Expected (handle: Buffer, radius: number)")
			.ThrowAsJavaScriptException();
		return env.Null();
	}

#ifdef __APPLE__
	auto handle = info[0].As<Napi::Buffer<uint8_t>>();
	double radius = info[1].As<Napi::Number>().DoubleValue();
	if (radius < 0) radius = 0;
	if (radius > 200) radius = 200;

	__block bool success = false;
	dispatch_block_t work = ^{
		NSWindow* window = WindowFromNativeHandle(handle);
		if (!window) return;
		NSView* contentView = window.contentView;
		if (!contentView) return;
		NSVisualEffectView* vev = FindVisualEffectView(contentView);
		if (!vev) return;
		vev.wantsLayer = YES;
		CALayer* layer = vev.layer;
		if (!layer) return;

		if (radius <= 0.0) {
			// Clear our override and let the NSVisualEffectView material
			// drive the appearance again.
			layer.backgroundFilters = @[];
			success = true;
			return;
		}

		CIFilter* blur = [CIFilter filterWithName:@"CIGaussianBlur"];
		if (!blur) return;
		[blur setDefaults];
		[blur setValue:@(radius) forKey:@"inputRadius"];
		if ([blur respondsToSelector:@selector(setName:)]) {
			[blur setValue:@"supersetVibrancyBlur" forKey:@"name"];
		}
		layer.backgroundFilters = @[blur];
		success = true;
	};
	if ([NSThread isMainThread]) {
		work();
	} else {
		dispatch_sync(dispatch_get_main_queue(), work);
	}
	return Napi::Boolean::New(env, success);
#else
	return Napi::Boolean::New(env, false);
#endif
}

/**
 * isSupported(): boolean — returns true on macOS builds where the native
 * code was compiled, false otherwise.
 */
Napi::Value IsSupported(const Napi::CallbackInfo& info) {
#ifdef __APPLE__
	return Napi::Boolean::New(info.Env(), true);
#else
	return Napi::Boolean::New(info.Env(), false);
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	exports.Set("setWindowBlurRadius",
		Napi::Function::New(env, SetWindowBlurRadius));
	exports.Set("isSupported", Napi::Function::New(env, IsSupported));
	return exports;
}

NODE_API_MODULE(macos_window_blur, Init)
