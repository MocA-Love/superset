/**
 * Conditional debug logger for vscode-shim.
 * Logs are shown in development mode (bun dev) but suppressed in production builds.
 */

const IS_DEV =
	process.env.NODE_ENV === "development" ||
	process.env.DEBUG_VSCODE_SHIM === "1";

export function shimLog(...args: unknown[]): void {
	if (IS_DEV) console.log(...args);
}

export function shimWarn(...args: unknown[]): void {
	if (IS_DEV) console.warn(...args);
}

export function shimError(...args: unknown[]): void {
	// Always log errors
	console.error(...args);
}
