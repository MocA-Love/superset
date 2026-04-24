import { describe, expect, it, mock } from "bun:test";
import {
	AivisError,
	type AivisTaskRunner,
	AudioScheduler,
	type AudioSchedulerDeps,
} from "./audio-scheduler";

interface RingtoneCall {
	onComplete: () => void;
}

interface SleepCall {
	ms: number;
	resolve: () => void;
}

function createDeps(
	overrides: Partial<AudioSchedulerDeps> = {},
): AudioSchedulerDeps & {
	ringtoneCalls: RingtoneCall[];
	pausedReasons: string[];
	errors: AivisError[];
	sleepCalls: SleepCall[];
	advance: (ms?: number) => void;
} {
	const ringtoneCalls: RingtoneCall[] = [];
	const pausedReasons: string[] = [];
	const errors: AivisError[] = [];
	const sleepCalls: SleepCall[] = [];

	return {
		ringtoneCalls,
		pausedReasons,
		errors,
		sleepCalls,
		playRingtone: (onComplete) => {
			ringtoneCalls.push({ onComplete });
		},
		notifyAivisPaused: (reason) => {
			pausedReasons.push(reason);
		},
		onError: (err) => {
			errors.push(err);
		},
		now: () => 0,
		// Deterministic sleep: return a promise that only resolves when
		// advance() flushes the matching pending call.
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				sleepCalls.push({ ms, resolve });
			}),
		advance: () => {
			const call = sleepCalls.shift();
			call?.resolve();
		},
		...overrides,
	};
}

function makeRunner(overrides: Partial<AivisTaskRunner> = {}): AivisTaskRunner {
	return {
		synthesize: mock(async () => ({
			audio: Buffer.from("audio"),
			rateLimit: undefined,
		})),
		play: mock(async () => {}),
		...overrides,
	};
}

async function flush(): Promise<void> {
	// Yield a few microtask turns so queued .then() callbacks run.
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("AudioScheduler", () => {
	describe("ringtone", () => {
		it("plays the ringtone when idle", () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.playRingtone();
			expect(deps.ringtoneCalls).toHaveLength(1);
		});

		it("drops a second ringtone while one is playing", () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.playRingtone();
			scheduler.playRingtone();
			expect(deps.ringtoneCalls).toHaveLength(1);
		});

		it("allows the next ringtone after the previous one completes", () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.playRingtone();
			deps.ringtoneCalls[0].onComplete();
			scheduler.playRingtone();
			expect(deps.ringtoneCalls).toHaveLength(2);
		});

		it("drops ringtone while an aivis task is running", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			let resolvePlay: () => void = () => {};
			const runner = makeRunner({
				play: () =>
					new Promise<void>((r) => {
						resolvePlay = r;
					}),
			});
			scheduler.enqueueAivis(runner);
			await flush();
			expect(scheduler.isAivisBusy).toBe(true);

			scheduler.playRingtone();
			expect(deps.ringtoneCalls).toHaveLength(0);

			resolvePlay();
			await flush();
			expect(scheduler.isAivisBusy).toBe(false);
		});

		it("defers aivis playback until ringtone finishes", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);

			scheduler.playRingtone();
			expect(deps.ringtoneCalls).toHaveLength(1);

			let synthesized = false;
			const playSpy = mock(async () => {});
			const runner = makeRunner({
				synthesize: async () => {
					synthesized = true;
					return { audio: Buffer.alloc(0), rateLimit: undefined };
				},
				play: playSpy,
			});
			scheduler.enqueueAivis(runner);
			await flush();
			await flush();

			// Synthesis happens in parallel with ringtone, but play must wait.
			expect(synthesized).toBe(true);
			expect(playSpy).not.toHaveBeenCalled();

			// Ringtone finishes → aivis play proceeds.
			deps.ringtoneCalls[0].onComplete();
			await flush();
			await flush();
			expect(playSpy).toHaveBeenCalled();
		});

		it("force-releases busy flag if onComplete never fires (safety timer)", async () => {
			const deps = createDeps({
				ringtoneSafetyTimeoutMs: 20,
				// deliberately discard onComplete to simulate contract violation
				playRingtone: () => {},
			});
			const scheduler = new AudioScheduler(deps);
			const playSpy = mock(async () => {});
			scheduler.playRingtone();
			scheduler.enqueueAivis(makeRunner({ play: playSpy }));
			await flush();
			await flush();
			// Aivis synth ran but play is parked behind the (hung) ringtone.
			expect(playSpy).not.toHaveBeenCalled();

			// Wait for the real setTimeout to fire the safety net.
			await new Promise((r) => setTimeout(r, 40));
			await flush();
			await flush();
			expect(playSpy).toHaveBeenCalled();
		});

		it("unblocks pending aivis playback on dispose", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.playRingtone();
			const playSpy = mock(async () => {});
			scheduler.enqueueAivis(makeRunner({ play: playSpy }));
			await flush();
			await flush();
			expect(playSpy).not.toHaveBeenCalled();

			// Dispose must not leave the scheduler hanging on
			// waitForRingtoneIdle; the pending runOne should short-circuit.
			scheduler.dispose();
			await flush();
			await flush();
			expect(playSpy).not.toHaveBeenCalled();
			expect(scheduler.isAivisBusy).toBe(false);
		});
	});

	describe("aivis queue", () => {
		it("plays tasks in FIFO order", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			const order: string[] = [];
			const r1 = makeRunner({
				play: async () => {
					order.push("a");
				},
			});
			const r2 = makeRunner({
				play: async () => {
					order.push("b");
				},
			});
			scheduler.enqueueAivis(r1);
			scheduler.enqueueAivis(r2);
			await flush();
			await flush();
			await flush();
			expect(order).toEqual(["a", "b"]);
		});

		it("places high-priority entries before pending normal entries", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			const order: string[] = [];

			// r1 is in-flight; r2 (normal) is queued; r3 (high) should jump ahead of r2.
			let resolveR1: () => void = () => {};
			const r1 = makeRunner({
				play: () =>
					new Promise<void>((resolve) => {
						resolveR1 = () => {
							order.push("r1");
							resolve();
						};
					}),
			});
			const r2 = makeRunner({
				play: async () => {
					order.push("r2");
				},
			});
			const r3 = makeRunner({
				play: async () => {
					order.push("r3");
				},
			});
			scheduler.enqueueAivis(r1);
			await flush();
			scheduler.enqueueAivis(r2, "normal");
			scheduler.enqueueAivis(r3, "high");

			resolveR1();
			await flush();
			await flush();
			await flush();

			expect(order).toEqual(["r1", "r3", "r2"]);
		});

		it("does not preempt the currently speaking task", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			let resolvePlay: () => void = () => {};
			const ongoing = makeRunner({
				play: () =>
					new Promise<void>((r) => {
						resolvePlay = r;
					}),
			});
			const highPriority = makeRunner();
			scheduler.enqueueAivis(ongoing);
			await flush();
			expect(scheduler.isAivisBusy).toBe(true);

			scheduler.enqueueAivis(highPriority, "high");
			// ongoing still runs — high-priority queued behind it.
			expect(highPriority.synthesize).not.toHaveBeenCalled();
			resolvePlay();
			await flush();
			await flush();
			expect(highPriority.synthesize).toHaveBeenCalled();
		});
	});

	describe("error handling", () => {
		it("retries retryable errors with exponential backoff", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			let attempts = 0;
			const runner = makeRunner({
				synthesize: async () => {
					attempts++;
					if (attempts < 3) {
						throw new AivisError("retryable", "boom", 500);
					}
					return { audio: Buffer.alloc(0), rateLimit: undefined };
				},
			});
			scheduler.enqueueAivis(runner);

			// attempt 1 throws — scheduler enters sleep
			await flush();
			expect(deps.sleepCalls).toHaveLength(1);
			expect(deps.sleepCalls[0].ms).toBe(1000);
			deps.advance();

			// attempt 2 throws — second backoff 2000
			await flush();
			expect(deps.sleepCalls[0].ms).toBe(2000);
			deps.advance();

			// attempt 3 succeeds
			await flush();
			expect(attempts).toBe(3);
			expect(deps.errors).toHaveLength(2); // two retryable errors observed
		});

		it("honors X-Aivis-RateLimit Reset on 429", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			let attempts = 0;
			const runner = makeRunner({
				synthesize: async () => {
					attempts++;
					if (attempts === 1) {
						throw new AivisError(
							"retryable",
							"rate limited",
							429,
							7 /* reset seconds */,
						);
					}
					return { audio: Buffer.alloc(0), rateLimit: undefined };
				},
			});
			scheduler.enqueueAivis(runner);
			await flush();
			// 7s reset + 0.5s margin = 7500ms
			expect(deps.sleepCalls[0].ms).toBe(7500);
			deps.advance();
			await flush();
			expect(attempts).toBe(2);
		});

		it("drains queue and pauses on fatal error", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			const runner1 = makeRunner({
				synthesize: async () => {
					throw new AivisError(
						"fatal",
						"Aivis のクレジット残高が不足しています",
						402,
					);
				},
			});
			const runner2 = makeRunner();
			scheduler.enqueueAivis(runner1);
			scheduler.enqueueAivis(runner2); // should be drained before it runs
			await flush();
			await flush();

			expect(scheduler.isPaused).toBe(true);
			expect(scheduler.aivisQueueSize).toBe(0);
			expect(runner2.synthesize).not.toHaveBeenCalled();
			expect(deps.pausedReasons).toEqual([
				"Aivis のクレジット残高が不足しています",
			]);
		});

		it("ignores new enqueues while paused", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.enqueueAivis(
				makeRunner({
					synthesize: async () => {
						throw new AivisError("fatal", "kaput", 401);
					},
				}),
			);
			await flush();
			await flush();
			expect(scheduler.isPaused).toBe(true);

			const later = makeRunner();
			scheduler.enqueueAivis(later);
			expect(later.synthesize).not.toHaveBeenCalled();
			expect(scheduler.aivisQueueSize).toBe(0);
		});

		it("skips item-specific errors but keeps processing queue", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			const bad = makeRunner({
				synthesize: async () => {
					throw new AivisError("item-specific", "bad payload", 422);
				},
			});
			const good = makeRunner();
			scheduler.enqueueAivis(bad);
			scheduler.enqueueAivis(good);
			await flush();
			await flush();
			await flush();

			expect(scheduler.isPaused).toBe(false);
			expect(good.synthesize).toHaveBeenCalled();
		});
	});

	describe("proactive rate limit", () => {
		it("waits for reset window when Remaining is 0", async () => {
			let currentTime = 0;
			const deps = createDeps({
				now: () => currentTime,
			});
			const scheduler = new AudioScheduler(deps);

			// First task returns rateLimit with remaining=0, reset=5s
			const first = makeRunner({
				synthesize: async () => ({
					audio: Buffer.alloc(0),
					rateLimit: {
						remaining: 0,
						resetSeconds: 5,
						capturedAt: currentTime,
					},
				}),
			});
			const second = makeRunner();

			scheduler.enqueueAivis(first);
			scheduler.enqueueAivis(second);
			await flush();
			await flush();

			// Second task should be waiting for 5000ms + 500ms margin
			expect(deps.sleepCalls).toHaveLength(1);
			expect(deps.sleepCalls[0].ms).toBe(5500);
			currentTime = 5500;
			deps.advance();
			await flush();
			expect(second.synthesize).toHaveBeenCalled();
		});

		it("does not wait when Remaining > 0", async () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			const first = makeRunner({
				synthesize: async () => ({
					audio: Buffer.alloc(0),
					rateLimit: { remaining: 5, resetSeconds: 60, capturedAt: 0 },
				}),
			});
			const second = makeRunner();
			scheduler.enqueueAivis(first);
			scheduler.enqueueAivis(second);
			await flush();
			await flush();
			await flush();
			expect(deps.sleepCalls).toHaveLength(0);
			expect(second.synthesize).toHaveBeenCalled();
		});
	});

	describe("dispose", () => {
		it("clears queue and rejects new tasks", () => {
			const deps = createDeps();
			const scheduler = new AudioScheduler(deps);
			scheduler.enqueueAivis(makeRunner());
			scheduler.enqueueAivis(makeRunner());
			scheduler.dispose();
			expect(scheduler.aivisQueueSize).toBe(0);
			const later = makeRunner();
			scheduler.enqueueAivis(later);
			expect(later.synthesize).not.toHaveBeenCalled();
		});
	});
});
