import { env } from "../env.renderer";

let sentryInitialized = false;

export async function initSentry(): Promise<void> {
	if (sentryInitialized) return;

	if (!env.SENTRY_DSN_DESKTOP || env.NODE_ENV !== "production") {
		return;
	}

	try {
		// Dynamic import to avoid bundler issues
		const Sentry = await import("@sentry/electron/renderer");

		// Patterns that are almost always external/noise rather than app bugs.
		// Keep this list short and specific — broad filters hide real regressions.
		const NOISY_ERROR_PATTERNS = [
			// Webview navigation (ERR_ABORTED, ERR_CONNECTION_REFUSED) — external sites
			"GUEST_VIEW_MANAGER_CALL",
			// User-cancelled fetches / navigations
			"The user aborted a request",
			"AbortError",
			// ResizeObserver loops warn but are benign
			"ResizeObserver loop",
			// Browser extension injection issues unrelated to our code
			"top.GLOBALS",
		];

		Sentry.init({
			dsn: env.SENTRY_DSN_DESKTOP,
			environment: env.NODE_ENV,
			tracesSampleRate: 0.1,
			beforeSend(event) {
				const message = event.exception?.values?.[0]?.value ?? "";
				if (
					NOISY_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
				) {
					return null;
				}
				return event;
			},
		});

		sentryInitialized = true;
		console.log("[sentry] Initialized in renderer process");
	} catch (error) {
		console.error("[sentry] Failed to initialize in renderer:", error);
	}
}
