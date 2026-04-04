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

		Sentry.init({
			dsn: env.SENTRY_DSN_DESKTOP,
			environment: env.NODE_ENV,
			tracesSampleRate: 0.1,
			beforeSend(event) {
				const message = event.exception?.values?.[0]?.value ?? "";
				// Webview navigation errors (ERR_ABORTED, ERR_CONNECTION_REFUSED, etc.)
				// are external-site issues, not actionable app bugs.
				if (message.includes("GUEST_VIEW_MANAGER_CALL")) {
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
