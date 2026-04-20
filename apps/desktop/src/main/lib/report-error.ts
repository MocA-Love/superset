import * as Sentry from "@sentry/electron/main";

type Severity = "fatal" | "error" | "warning" | "info" | "debug";

interface ReportErrorOptions {
	/** Sentry severity level. Defaults to "error". */
	severity?: Severity;
	/** Tags for grouping in the Sentry dashboard (e.g. { subsystem: "daemon" }). */
	tags?: Record<string, string>;
	/** Additional context shown alongside the event. */
	context?: Record<string, unknown>;
	/** Which Sentry "fingerprint" bucket to group into. Override when the default stack-based grouping clumps unrelated issues together. */
	fingerprint?: string[];
}

/**
 * Reports an error to Sentry from the main process.
 *
 * Prefer this over raw `Sentry.captureException` for non-tRPC paths, so we get
 * consistent severity/tags/context and a single seam to change filtering later.
 */
export function reportError(
	error: unknown,
	options: ReportErrorOptions = {},
): void {
	const { severity = "error", tags, context, fingerprint } = options;

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
}
