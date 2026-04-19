import type {
	DebugChannelOptions,
	DebugChannelTransport,
} from "shared/debug-channel";
import { createDebugChannel } from "shared/debug-channel";

let sentryModulePromise: Promise<
	typeof import("@sentry/electron/main")
> | null = null;

function getSentry() {
	if (!sentryModulePromise) {
		sentryModulePromise = import("@sentry/electron/main");
	}
	return sentryModulePromise;
}

function createMainTransport(): DebugChannelTransport {
	return {
		addBreadcrumb(entry) {
			void getSentry()
				.then((Sentry) => {
					Sentry.addBreadcrumb({
						category: entry.namespace,
						level: entry.level,
						message: entry.message,
						data: entry.data,
					});
				})
				.catch(() => {});
		},
		captureMessage(entry) {
			void getSentry()
				.then((Sentry) => {
					Sentry.withScope((scope) => {
						scope.setLevel(entry.level);
						scope.setTag("debug_namespace", entry.namespace);
						if (entry.fingerprint) {
							scope.setFingerprint(entry.fingerprint);
						}
						if (entry.data) {
							scope.setContext("debug", entry.data);
						}
						Sentry.captureMessage(`[${entry.namespace}] ${entry.message}`);
					});
				})
				.catch(() => {});
		},
		captureException(error, entry) {
			void getSentry()
				.then((Sentry) => {
					Sentry.withScope((scope) => {
						scope.setLevel(entry.level);
						scope.setTag("debug_namespace", entry.namespace);
						if (entry.fingerprint) {
							scope.setFingerprint(entry.fingerprint);
						}
						if (entry.data) {
							scope.setContext("debug", entry.data);
						}
						Sentry.captureException(error);
					});
				})
				.catch(() => {});
		},
	};
}

export function createMainDebugChannel(
	options: Omit<DebugChannelOptions, "transport">,
) {
	return createDebugChannel({
		...options,
		transport: createMainTransport(),
	});
}
