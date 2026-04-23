/**
 * Coordinates audible notifications (ringtone + Aivis TTS) so they never
 * overlap.
 *
 * Rules (see plans / conversation that introduced this file):
 * - Ringtone: drop if any audio channel is busy. A ringtone carries no
 *   information, so silently skipping a second one is safe.
 * - Aivis: FIFO queue so spoken context is never lost. PermissionRequest
 *   events cut in front of pending Stop events (but never preempt the
 *   currently speaking utterance).
 * - Rate limit: Aivis Cloud returns X-Aivis-RateLimit-Requests-* headers
 *   (subscription plans). When Remaining reaches 0, wait Reset+0.5s before
 *   sending the next request instead of hitting 429.
 * - Error policy:
 *     Retryable (429, 5xx, network/timeout) - exponential backoff, max 3.
 *     Fatal (401, 402, 404) - drain the queue, mark paused, surface an
 *       OS notification. The user has to fix their API key / credit /
 *       model config; no automatic resume.
 *     Item-specific (422) - skip just this item, keep processing others.
 */

export type AivisErrorKind = "retryable" | "fatal" | "item-specific";

export interface AivisRateLimit {
	/** Requests remaining in the current window (from response header). */
	remaining: number;
	/** Seconds until the window resets (from response header). */
	resetSeconds: number;
	/** Local timestamp when the header was observed. */
	capturedAt: number;
}

export class AivisError extends Error {
	constructor(
		readonly kind: AivisErrorKind,
		readonly reason: string,
		readonly status?: number,
		/** For 429: seconds to wait before retrying (from header). */
		readonly rateLimitReset?: number,
		cause?: unknown,
	) {
		super(reason);
		this.name = "AivisError";
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

export interface AivisSynthesizeResult {
	audio: Buffer;
	rateLimit?: AivisRateLimit;
}

/**
 * A single queueable Aivis task. Scheduler calls synthesize() (may throw
 * AivisError), then play() with the returned audio. play() resolves on
 * playback completion (or rejects — treated as item-specific failure).
 */
export interface AivisTaskRunner {
	synthesize(): Promise<AivisSynthesizeResult>;
	play(audio: Buffer): Promise<void>;
}

export type AivisPriority = "normal" | "high";

export interface AudioSchedulerDeps {
	/**
	 * Play the configured notification ringtone. onComplete must fire
	 * exactly once, whether playback succeeded, was skipped (muted / no
	 * file), or failed.
	 */
	playRingtone(onComplete: () => void): void;
	/**
	 * Surface a visible "Aivis paused" notification to the user when the
	 * queue is drained due to a fatal error.
	 */
	notifyAivisPaused(reason: string): void;
	/** Hook for telemetry / logging. Optional. */
	onError?(err: AivisError): void;
	/** Injected clock for tests. Defaults to Date.now. */
	now?(): number;
	/** Injected sleep for tests. Defaults to setTimeout. */
	sleep?(ms: number): Promise<void>;
}

const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
const RATE_LIMIT_MARGIN_MS = 500;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QueueEntry {
	priority: AivisPriority;
	runner: AivisTaskRunner;
}

export class AudioScheduler {
	private ringtoneBusy = false;
	private aivisBusy = false;
	private queue: QueueEntry[] = [];
	private paused = false;
	private rateLimit?: AivisRateLimit;
	private disposed = false;

	constructor(private readonly deps: AudioSchedulerDeps) {}

	playRingtone(): void {
		if (this.disposed) return;
		if (this.ringtoneBusy || this.aivisBusy) return;
		this.ringtoneBusy = true;
		try {
			this.deps.playRingtone(() => {
				this.ringtoneBusy = false;
			});
		} catch (err) {
			this.ringtoneBusy = false;
			console.warn("[audio-scheduler] ringtone failed", err);
		}
	}

	enqueueAivis(
		runner: AivisTaskRunner,
		priority: AivisPriority = "normal",
	): void {
		if (this.disposed || this.paused) return;
		const entry: QueueEntry = { priority, runner };
		if (priority === "high") {
			const firstNormal = this.queue.findIndex((e) => e.priority === "normal");
			if (firstNormal < 0) this.queue.push(entry);
			else this.queue.splice(firstNormal, 0, entry);
		} else {
			this.queue.push(entry);
		}
		void this.pump();
	}

	get aivisQueueSize(): number {
		return this.queue.length;
	}

	get isAivisBusy(): boolean {
		return this.aivisBusy;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/** Clear the pause state (e.g. after the user fixes their API key). */
	resume(): void {
		if (this.disposed) return;
		this.paused = false;
	}

	dispose(): void {
		this.disposed = true;
		this.queue = [];
	}

	private async pump(): Promise<void> {
		if (this.aivisBusy) return;
		if (this.disposed || this.paused) return;
		const entry = this.queue.shift();
		if (!entry) return;
		this.aivisBusy = true;
		try {
			await this.runOne(entry.runner);
		} finally {
			this.aivisBusy = false;
			if (!this.disposed && !this.paused && this.queue.length > 0) {
				void this.pump();
			}
		}
	}

	private async runOne(runner: AivisTaskRunner): Promise<void> {
		await this.waitForRateLimitWindow();

		let lastErr: AivisError | undefined;
		for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
			if (this.disposed) return;
			try {
				const { audio, rateLimit } = await runner.synthesize();
				if (rateLimit) this.rateLimit = rateLimit;
				try {
					await runner.play(audio);
				} catch (playErr) {
					// Playback failures don't justify retrying synthesis.
					const wrapped = new AivisError(
						"item-specific",
						"Aivis 音声の再生に失敗しました",
						undefined,
						undefined,
						playErr,
					);
					this.deps.onError?.(wrapped);
				}
				return;
			} catch (err) {
				const aivisErr = toAivisError(err);
				lastErr = aivisErr;
				this.deps.onError?.(aivisErr);

				if (aivisErr.kind === "fatal") {
					this.drainAndPause(aivisErr.reason);
					return;
				}
				if (aivisErr.kind === "item-specific") {
					return;
				}
				// Retryable — sleep and retry (unless last attempt).
				if (attempt >= MAX_RETRY_ATTEMPTS) break;
				const waitMs = this.computeBackoffMs(aivisErr, attempt);
				await (this.deps.sleep ?? defaultSleep)(waitMs);
			}
		}

		if (lastErr) {
			console.warn(
				`[audio-scheduler] aivis task gave up after ${MAX_RETRY_ATTEMPTS} attempts: ${lastErr.reason}`,
			);
		}
	}

	private computeBackoffMs(err: AivisError, attempt: number): number {
		if (err.status === 429 && err.rateLimitReset !== undefined) {
			return Math.max(0, err.rateLimitReset * 1000 + RATE_LIMIT_MARGIN_MS);
		}
		return DEFAULT_BACKOFF_MS[attempt - 1] ?? DEFAULT_BACKOFF_MS.at(-1) ?? 4000;
	}

	private async waitForRateLimitWindow(): Promise<void> {
		const rl = this.rateLimit;
		if (!rl || rl.remaining > 0) return;
		const now = (this.deps.now ?? Date.now)();
		const elapsedMs = now - rl.capturedAt;
		const waitMs = rl.resetSeconds * 1000 - elapsedMs + RATE_LIMIT_MARGIN_MS;
		if (waitMs <= 0) return;
		await (this.deps.sleep ?? defaultSleep)(waitMs);
	}

	private drainAndPause(reason: string): void {
		const dropped = this.queue.length;
		this.queue = [];
		this.paused = true;
		this.deps.notifyAivisPaused(reason);
		if (dropped > 0) {
			console.info(
				`[audio-scheduler] dropped ${dropped} queued Aivis task(s) after fatal error: ${reason}`,
			);
		}
	}
}

function toAivisError(err: unknown): AivisError {
	if (err instanceof AivisError) return err;
	if (err instanceof Error && err.name === "AbortError") {
		return new AivisError(
			"retryable",
			"Aivis API のリクエストがタイムアウトしました",
			undefined,
			undefined,
			err,
		);
	}
	// Network errors from fetch land here — treat as retryable.
	return new AivisError(
		"retryable",
		err instanceof Error ? err.message : String(err),
		undefined,
		undefined,
		err,
	);
}
