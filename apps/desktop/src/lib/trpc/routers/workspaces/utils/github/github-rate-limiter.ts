/**
 * Centralized GitHub API rate limiter.
 *
 * Detects HTTP 403 (secondary rate limit) errors from `gh` CLI commands
 * and pauses ALL GitHub API calls with exponential backoff until the
 * rate limit window resets.
 */

const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
const BACKOFF_MULTIPLIER = 2;

let pausedUntil = 0;
let currentBackoffMs = INITIAL_BACKOFF_MS;
let consecutiveFailures = 0;

export function isRateLimited(): boolean {
	return Date.now() < pausedUntil;
}

export function getRateLimitResumeTime(): number {
	return pausedUntil;
}

export function onRateLimitHit(): void {
	consecutiveFailures++;
	currentBackoffMs = Math.min(
		INITIAL_BACKOFF_MS * BACKOFF_MULTIPLIER ** (consecutiveFailures - 1),
		MAX_BACKOFF_MS,
	);
	pausedUntil = Date.now() + currentBackoffMs;
	console.warn(
		`[GitHub] Rate limit hit. Pausing all API calls for ${currentBackoffMs / 1000}s (attempt ${consecutiveFailures})`,
	);
}

export function onRateLimitSuccess(): void {
	if (consecutiveFailures > 0) {
		consecutiveFailures = 0;
		currentBackoffMs = INITIAL_BACKOFF_MS;
		console.log("[GitHub] Rate limit recovered. Resuming normal operations.");
	}
}

export function isSecondaryRateLimitError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message || "";
	const stdout =
		"stdout" in error && typeof error.stdout === "string" ? error.stdout : "";

	return (
		message.includes("secondary rate limit") ||
		message.includes("HTTP 403") ||
		stdout.includes("secondary rate limit") ||
		stdout.includes("exceeded a secondary rate limit")
	);
}
