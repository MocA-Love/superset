#include <napi.h>
#include <stdio.h>

#ifdef __APPLE__
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#define VDBG(...)                                            \
	do {                                                     \
		fprintf(stderr, "[macos-window-blur] " __VA_ARGS__); \
		fprintf(stderr, "\n");                               \
		fflush(stderr);                                      \
	} while (0)

static const void* kOriginalBlurRadiusKey = &kOriginalBlurRadiusKey;

/**
 * Walk the view hierarchy rooted at `root` looking for an NSVisualEffectView.
 * Electron inserts one of these to implement BrowserWindow's `vibrancy`
 * option and it owns the backdrop layer we need to mutate.
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

/**
 * Recursively look for a CALayer whose class name matches `className`.
 * The real CABackdropLayer that does the blur may be nested several
 * sublayers deep inside the NSVisualEffectView's own layer hierarchy,
 * so we can't just check `vev.layer` directly.
 */
static CALayer* FindLayerByClassName(CALayer* root, NSString* className) {
	if (!root) return nil;
	if ([NSStringFromClass([root class]) isEqualToString:className]) {
		return root;
	}
	Class target = NSClassFromString(className);
	if (target && [root isKindOfClass:target]) {
		return root;
	}
	for (CALayer* sublayer in root.sublayers) {
		CALayer* found = FindLayerByClassName(sublayer, className);
		if (found) return found;
	}
	return nil;
}

static id FindBackdropFilter(NSArray* filters, NSString* wantedType) {
	for (id filter in filters) {
		NSString* name = nil;
		NSString* type = nil;
		@try {
			name = [filter valueForKey:@"name"];
		} @catch (NSException*) {}
		@try {
			type = [filter valueForKey:@"type"];
		} @catch (NSException*) {}
		if ([name isEqualToString:wantedType] ||
			[type isEqualToString:wantedType]) {
			return filter;
		}
	}
	return nil;
}

static void ApplyBlurRadiusToBackdrop(CALayer* backdrop, double radius) {
	// Remember the system-provided default so the caller can restore it
	// later by passing radius <= 0.
	NSNumber* stored =
		objc_getAssociatedObject(backdrop, kOriginalBlurRadiusKey);
	if (!stored) {
		id existing = FindBackdropFilter(backdrop.filters, @"gaussianBlur");
		double initial = 0.0;
		if (existing) {
			@try {
				initial = [[existing valueForKey:@"inputRadius"] doubleValue];
			} @catch (NSException*) {}
		}
		objc_setAssociatedObject(
			backdrop,
			kOriginalBlurRadiusKey,
			@(initial > 0.0 ? initial : 30.0),
			OBJC_ASSOCIATION_RETAIN_NONATOMIC);
		stored = objc_getAssociatedObject(backdrop, kOriginalBlurRadiusKey);
	}

	double effective = radius <= 0.0 ? stored.doubleValue : radius;

	// Mutating an existing CAFilter's inputRadius in place is accepted by
	// the setter but Core Animation does not observe property changes on
	// the filter object, so the layer never re-renders. Replace the
	// existing gaussianBlur with a brand-new CAFilter instance and
	// reassign `backdrop.filters`, which does fire the layer's property
	// observer and schedules a display pass.
	Class cls = NSClassFromString(@"CAFilter");
	if (!cls || ![cls respondsToSelector:@selector(filterWithType:)]) return;
	id replacement = [cls performSelector:@selector(filterWithType:)
								withObject:@"gaussianBlur"];
	if (!replacement) return;
	@try {
		[replacement setValue:@"gaussianBlur" forKey:@"name"];
	} @catch (NSException*) {}
	@try {
		[replacement setValue:@YES forKey:@"inputNormalizeEdges"];
	} @catch (NSException*) {}
	[replacement setValue:@(effective) forKey:@"inputRadius"];

	NSMutableArray* next =
		[NSMutableArray arrayWithArray:backdrop.filters ?: @[]];
	BOOL replaced = NO;
	for (NSUInteger i = 0; i < next.count; i++) {
		id entry = next[i];
		NSString* name = nil;
		NSString* type = nil;
		@try {
			name = [entry valueForKey:@"name"];
		} @catch (NSException*) {}
		@try {
			type = [entry valueForKey:@"type"];
		} @catch (NSException*) {}
		if ([name isEqualToString:@"gaussianBlur"] ||
			[type isEqualToString:@"gaussianBlur"]) {
			next[i] = replacement;
			replaced = YES;
			break;
		}
	}
	if (!replaced) {
		[next addObject:replacement];
	}
	backdrop.filters = next;
	[backdrop setNeedsDisplay];
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
 * Walks into the NSVisualEffectView that Electron created for the window,
 * finds its private CABackdropLayer, and rewrites the `gaussianBlur`
 * CAFilter in place with the requested radius. Passing `radius <= 0`
 * restores the original system-provided radius so the material looks
 * normal again.
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
		VDBG("setWindowBlurRadius called: radius=%.2f", radius);

		NSWindow* window = WindowFromNativeHandle(handle);
		if (!window) {
			VDBG("  window lookup failed (invalid handle)");
			return;
		}
		NSView* contentView = window.contentView;
		if (!contentView) {
			VDBG("  window has no contentView");
			return;
		}
		NSVisualEffectView* vev = FindVisualEffectView(contentView);
		if (!vev) {
			VDBG("  NSVisualEffectView not found in contentView hierarchy");
			return;
		}
		VDBG("  found NSVisualEffectView (material=%ld state=%ld)",
			(long)vev.material, (long)vev.state);
		[contentView layoutSubtreeIfNeeded];
		[vev layoutSubtreeIfNeeded];
		vev.wantsLayer = YES;
		CALayer* outerLayer = vev.layer;
		VDBG("  vev.layer class = %s",
			outerLayer ? [NSStringFromClass([outerLayer class]) UTF8String]
			           : "(nil)");
		CALayer* backdrop = FindLayerByClassName(vev.layer, @"CABackdropLayer");
		if (!backdrop) {
			VDBG("  CABackdropLayer not found — dumping sublayer tree:");
			@try {
				[outerLayer.sublayers enumerateObjectsUsingBlock:^(
					CALayer* sub, NSUInteger idx, BOOL* stop) {
					(void)stop;
					VDBG("    [%lu] %s frame=%.0fx%.0f",
						(unsigned long)idx,
						[NSStringFromClass([sub class]) UTF8String],
						sub.frame.size.width,
						sub.frame.size.height);
				}];
			} @catch (NSException*) {}
			return;
		}
		VDBG("  backdrop layer class=%s filters=%lu",
			[NSStringFromClass([backdrop class]) UTF8String],
			(unsigned long)backdrop.filters.count);
		@try {
			[backdrop.filters enumerateObjectsUsingBlock:^(
				id filter, NSUInteger idx, BOOL* stop) {
				(void)stop;
				NSString* name = nil;
				NSString* type = nil;
				@try {
					name = [filter valueForKey:@"name"];
				} @catch (NSException*) {}
				@try {
					type = [filter valueForKey:@"type"];
				} @catch (NSException*) {}
				VDBG("    pre filter[%lu] class=%s name=%s type=%s",
					(unsigned long)idx,
					[NSStringFromClass([filter class]) UTF8String],
					name ? [name UTF8String] : "(nil)",
					type ? [type UTF8String] : "(nil)");
			}];
		} @catch (NSException*) {}

		[CATransaction begin];
		[CATransaction setDisableActions:YES];
		ApplyBlurRadiusToBackdrop(backdrop, radius);
		[backdrop setNeedsDisplay];
		[backdrop setNeedsLayout];
		[CATransaction commit];
		[CATransaction flush];
		// Force a synchronous display pass so the new filter value is
		// picked up immediately rather than waiting for the next vsync.
		@try {
			[backdrop displayIfNeeded];
		} @catch (NSException*) {}

		{
			id postBlur = FindBackdropFilter(backdrop.filters, @"gaussianBlur");
			double effective = 0.0;
			if (postBlur) {
				@try {
					effective = [[postBlur valueForKey:@"inputRadius"] doubleValue];
				} @catch (NSException*) {}
			}
			VDBG("  after mutation: gaussianBlur inputRadius=%.2f (filter count=%lu)",
				effective, (unsigned long)backdrop.filters.count);
		}
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
