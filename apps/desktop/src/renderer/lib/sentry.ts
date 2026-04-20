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
		// Every entry should come with a Sentry issue link showing why it's noise,
		// so future readers can decide whether a pattern is still unactionable.
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
			// react-dnd v16 race: drop event arrives while a hover is still in
			// flight. ELECTRON-1V / ELECTRON-1T (21+ events, library-internal).
			"Cannot call hover after drop",
			// react-mosaic-component v6 internal race during drag-end when the
			// target path has collapsed to a leaf. ELECTRON-1R / ELECTRON-1S.
			"Cannot create property 'splitPercentage' on string",
			// CodeMirror guard already handled by deferring our own dispatch
			// (createInlineCompletionPlugin). Suppress any late-fire from
			// third-party plugins that still violate the invariant.
			"Calls to EditorView.update are not allowed while an update is in progress",
		];

		Sentry.init({
			dsn: env.SENTRY_DSN_DESKTOP,
			environment: env.NODE_ENV,
			tracesSampleRate: 0.1,
			beforeSend(event) {
				const firstException = event.exception?.values?.[0];
				const message = firstException?.value ?? "";
				if (
					NOISY_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
				) {
					return null;
				}
				// xterm.js v6 internal race: rAF fires after terminal dispose when
				// _renderer.value is already undefined (ELECTRON-17 / ELECTRON-V)。
				// xterm のスタック由来の時だけ握りつぶす。
				// NOTE: `dimensions` undefined はチャート・canvas・画像処理など
				// アプリ側の実バグで将来いくらでも生まれ得る。メッセージ単独で
				// 全て黙らせると実バグが静かに消えるので、stacktrace に xterm が
				// 含まれる場合のみフィルタする。
				if (
					message.includes(
						"Cannot read properties of undefined (reading 'dimensions')",
					)
				) {
					const frames = firstException?.stacktrace?.frames ?? [];
					const fromXterm = frames.some((f) =>
						f.filename?.includes("xterm"),
					);
					if (fromXterm) {
						return null;
					}
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
