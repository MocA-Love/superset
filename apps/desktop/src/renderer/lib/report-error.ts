type Severity = "fatal" | "error" | "warning" | "info" | "debug";

interface ReportErrorOptions {
	/** Sentry severity level. Defaults to "error". */
	severity?: Severity;
	/** Tags for grouping in the Sentry dashboard (e.g. { subsystem: "settings" }). */
	tags?: Record<string, string>;
	/** Additional context shown alongside the event. */
	context?: Record<string, unknown>;
	/** Which Sentry "fingerprint" bucket to group into. */
	fingerprint?: string[];
}

/**
 * Reports an error to Sentry from the renderer process.
 *
 * Uses dynamic import so boot paths that never initialize Sentry don't pay
 * the cost. Intentionally fire-and-forget (never throws) so callers can use it
 * in catch handlers without extra guards.
 */
export function reportError(
	error: unknown,
	options: ReportErrorOptions = {},
): void {
	const { severity = "error", tags, context, fingerprint } = options;

	void import("@sentry/electron/renderer")
		.then((Sentry) => {
			Sentry.withScope((scope) => {
				scope.setLevel(severity);
				if (tags) {
					for (const [k, v] of Object.entries(tags)) {
						scope.setTag(k, v);
					}
				}
				if (context) {
					scope.setContext("details", context);
				}
				if (fingerprint) {
					scope.setFingerprint(fingerprint);
				}
				Sentry.captureException(error);
			});
		})
		.catch((importError) => {
			console.error("[report-error] Failed to load Sentry:", importError);
		});
}
