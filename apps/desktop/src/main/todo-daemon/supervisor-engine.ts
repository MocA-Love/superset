import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SelectTodoSession } from "@superset/local-db";
import { getCurrentHeadSha } from "main/todo-agent/git-status";
import {
	getTodoSessionStore,
	resolveWorktreePath,
} from "main/todo-agent/session-store";
import { getTodoSettings } from "main/todo-agent/settings";
import {
	CLAUDE_EFFORT_OPTIONS,
	CLAUDE_MODEL_OPTIONS,
	type TodoStreamEventKind,
} from "main/todo-agent/types";
import { runClaudeTurnPty } from "./pty-turn-runner";

/**
 * Feature flag for the interactive PTY engine. When the daemon process
 * is launched with `TODO_ENGINE=pty`, `runClaudeTurn` dispatches to the
 * PTY runner (apps/desktop/src/main/todo-daemon/pty-turn-runner.ts)
 * which supports Remote Control. Otherwise, the legacy `-p` headless
 * path is used. The flag is process-wide (not per-session) because it
 * governs which spawn path the daemon knows how to manage; Remote
 * Control itself is still opt-in per session via
 * `todo_sessions.remote_control_enabled`.
 */
const PTY_ENGINE_ENABLED = process.env.TODO_ENGINE === "pty";

/**
 * Daemon-side supervisor engine. Spawns `claude -p` children for TODO
 * sessions and drives their iteration loop.
 *
 * The original in-main supervisor used to live at
 * `main/todo-agent/supervisor.ts`; it has been moved here so the claude
 * children survive app restarts — see issue #237.
 *
 * This file is intentionally kept close to the original implementation;
 * all calls to `getTodoSessionStore()` write to the daemon-local SQLite
 * connection, and the daemon bridge re-broadcasts those writes to the
 * connected main processes over the NDJSON socket.
 */

interface ActiveRun {
	sessionId: string;
	abortController: AbortController;
	lastFailingTest?: string;
	consecutiveSameFailure: number;
	startedAt: number;
	currentChild: ChildProcess | null;
}

export class TodoSupervisorEngine {
	private readonly active = new Map<string, ActiveRun>();
	private readonly queue: string[] = [];
	/**
	 * Sessions whose next queued start was triggered by `ScheduleWakeup`
	 * firing (scheduler.resumeDueWaitingSessions), not by a user click or
	 * a follow-up intervention. `runSession` consumes the marker to skip
	 * the "セッションを再開します" banner and to send a short continuation
	 * prompt instead of re-replaying the original goal — which Claude
	 * has already been working on in the same `--resume`d session. See
	 * issue #240.
	 */
	private readonly wakeupResumeMarkers = new Set<string>();

	listActiveSessionIds(): string[] {
		return Array.from(this.active.keys());
	}

	async start(
		sessionId: string,
		options?: { fromScheduledWakeup?: boolean },
	): Promise<void> {
		if (options?.fromScheduledWakeup) {
			this.wakeupResumeMarkers.add(sessionId);
		} else {
			// A manual start (user click / follow-up intervention) always
			// overrides a stale scheduler marker. Prevents a prior wakeup
			// that never actually ran (e.g. abort landed between claim and
			// drain) from silently relabeling the next manual resume.
			this.wakeupResumeMarkers.delete(sessionId);
		}
		if (this.queue.includes(sessionId)) return;
		const active = this.active.get(sessionId);
		if (active && !active.abortController.signal.aborted) return;
		this.queue.push(sessionId);
		this.drain();
	}

	handleSettingsChanged(): void {
		this.drain();
	}

	private drain(): void {
		const capacity = getTodoSettings().maxConcurrentTasks;
		while (this.active.size < capacity && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) continue;
			const latest = getTodoSessionStore().get(next);
			if (!latest) continue;
			if (
				latest.status === "aborted" ||
				latest.status === "failed" ||
				latest.status === "done" ||
				latest.status === "escalated"
			) {
				continue;
			}
			void this.runSession(next)
				.catch((err) => {
					console.warn(`[todo-daemon] runSession crashed for ${next}:`, err);
				})
				.finally(() => {
					this.drain();
				});
		}
	}

	abort(sessionId: string): void {
		const store = getTodoSessionStore();
		const queueIdx = this.queue.indexOf(sessionId);
		if (queueIdx !== -1) {
			this.queue.splice(queueIdx, 1);
		}
		// Clear any wakeup-resume marker so a subsequent manual start
		// cannot misinterpret this session as a scheduler wakeup.
		this.wakeupResumeMarkers.delete(sessionId);
		const activeRun = this.active.get(sessionId);
		if (activeRun) {
			activeRun.abortController.abort();
			const child = activeRun.currentChild;
			if (child?.pid) {
				const pid = child.pid;
				killProcessTree(pid, "SIGINT");
				const kill = setTimeout(() => {
					if (child.exitCode == null && child.signalCode == null) {
						killProcessTree(pid, "SIGKILL");
					}
				}, 1500);
				child.once("close", () => clearTimeout(kill));
			}
		}
		const session = store.get(sessionId);
		if (!session) return;
		if (
			session.status !== "done" &&
			session.status !== "failed" &&
			session.status !== "escalated" &&
			session.status !== "aborted"
		) {
			store.update(sessionId, {
				status: "aborted",
				phase: "aborted",
				completedAt: Date.now(),
			});
		}
	}

	queueIntervention(sessionId: string, data: string): void {
		const store = getTodoSessionStore();
		const existing = store.get(sessionId);
		if (!existing) return;
		const previous = existing.pendingIntervention?.trim();
		const next = [previous, data.trim()].filter(Boolean).join("\n\n");
		store.update(sessionId, { pendingIntervention: next });
	}

	/**
	 * Abort every active run without flipping the `todo_sessions` status.
	 * Used when the daemon itself is being shut down — marking sessions
	 * as aborted would be a lie, since the user did not request it.
	 */
	shutdownAll(opts: { killChildren: boolean }): void {
		for (const run of this.active.values()) {
			run.abortController.abort();
			if (opts.killChildren) {
				const child = run.currentChild;
				if (child?.pid) killProcessTree(child.pid, "SIGINT");
			}
		}
	}

	private async runSession(sessionId: string): Promise<void> {
		const store = getTodoSessionStore();
		const session0 = store.get(sessionId);
		if (!session0) return;

		// Consume the wakeup-resume marker (if any). A scheduler-driven
		// resume from a `ScheduleWakeup`-paused session is not a new
		// turn from Claude's perspective — Claude asked to be paged
		// back later and is now continuing the same reasoning. Treat
		// it differently from the user-driven done→follow-up resume.
		const isFromScheduledWakeup = this.wakeupResumeMarkers.delete(sessionId);

		const isResumingPastRun = !!session0.claudeSessionId;
		if (!isResumingPastRun) {
			store.clearStreamEvents(sessionId);
		}
		store.setArtifactPathCache(sessionId, session0.artifactPath);
		// Scheduler-driven wakeup resumes skip the "再開" banner —
		// Claude requested the pause itself, so the pause+wakeup is a
		// single logical turn and does not warrant a new-session marker.
		if (isResumingPastRun && !isFromScheduledWakeup) {
			appendSetupEvent(
				sessionId,
				"再開",
				"セッションを再開します。これより下が新しいターンのストリームです。",
			);
		}

		const ac = new AbortController();
		const run: ActiveRun = {
			sessionId,
			abortController: ac,
			consecutiveSameFailure: 0,
			startedAt: Date.now(),
			currentChild: null,
		};
		this.active.set(sessionId, run);

		try {
			appendSetupEvent(
				sessionId,
				"セットアップ",
				"ワークスペースを解決しています…",
			);
			const worktreePath = resolveWorktreePath(session0.workspaceId);
			if (worktreePath) {
				appendSetupEvent(sessionId, "worktree", worktreePath);
			}
			const startHeadSha =
				session0.startHeadSha ??
				(worktreePath ? await getCurrentHeadSha(worktreePath) : null);
			if (startHeadSha) {
				appendSetupEvent(
					sessionId,
					"開始時 HEAD",
					`${startHeadSha.slice(0, 12)}`,
				);
			}
			if (session0.verifyCommand) {
				appendSetupEvent(sessionId, "verify", session0.verifyCommand);
			} else {
				appendSetupEvent(sessionId, "モード", "単発タスク（外部 verify なし）");
			}
			appendSetupEvent(
				sessionId,
				"予算",
				`${session0.maxIterations} iter · ${Math.round(session0.maxWallClockSec / 60)} 分`,
			);
			if (session0.customSystemPrompt?.trim()) {
				const preview = session0.customSystemPrompt
					.trim()
					.replace(/\s+/g, " ")
					.slice(0, 200);
				appendSetupEvent(
					sessionId,
					"システムプロンプト",
					`${preview}${session0.customSystemPrompt.trim().length > 200 ? "…" : ""}`,
				);
			}
			if (session0.claudeModel || session0.claudeEffort) {
				const parts: string[] = [];
				if (session0.claudeModel) parts.push(`model: ${session0.claudeModel}`);
				if (session0.claudeEffort)
					parts.push(`effort: ${session0.claudeEffort}`);
				appendSetupEvent(sessionId, "Claude 設定", parts.join(" / "));
			}
			const willUsePty =
				PTY_ENGINE_ENABLED || Boolean(session0.remoteControlEnabled);
			appendSetupEvent(
				sessionId,
				"Claude",
				willUsePty
					? "claude を PTY (interactive) モードで起動します"
					: "claude -p --output-format stream-json を起動します",
			);
			if (session0.remoteControlEnabled) {
				appendSetupEvent(
					sessionId,
					"Remote Control",
					"有効 (PTY モード)。起動後に接続 URL を発行します。",
				);
			}
			if (willUsePty) {
				// PTY 経路は Claude Code JSONL に cost_usd が載らない
				// ため totalCostUsd の集計は当面行われません。ユーザー
				// 可観測性のためセットアップバナーに明示します
				// (CodeRabbit review #278)。
				appendSetupEvent(
					sessionId,
					"計測",
					"PTY モードではコスト (USD) の集計が無効化されます。ターン数は計測されます。",
				);
			}

			const preservedClaudeSessionId = isResumingPastRun
				? (session0.claudeSessionId ?? null)
				: null;
			store.update(sessionId, {
				status: "running",
				phase: "running",
				startedAt: Date.now(),
				completedAt: null,
				verdictPassed: null,
				verdictReason: null,
				verdictFailingTest: null,
				// Keep the prior assistant text on a user-driven resume
				// so the Manager shows the last known answer while the
				// new turn streams. On a scheduler wakeup, clear it —
				// the stale response has been visible the whole time
				// under the "待機中" label and the user wants a clean
				// slate under the "最終回答" label once the new turn
				// starts producing output (issue #240).
				finalAssistantText:
					isResumingPastRun && !isFromScheduledWakeup
						? (session0.finalAssistantText ?? null)
						: null,
				claudeSessionId: preservedClaudeSessionId,
				totalCostUsd: isResumingPastRun
					? (session0.totalCostUsd ?? null)
					: null,
				totalNumTurns: isResumingPastRun
					? (session0.totalNumTurns ?? null)
					: null,
				iteration: 0,
				startHeadSha,
				waitingUntil: null,
				waitingReason: null,
			});

			if (!worktreePath) {
				store.update(sessionId, {
					status: "failed",
					phase: "failed",
					verdictReason:
						"ワークスペースのパスを解決できませんでした（worktree も mainRepoPath も見つからない）",
					completedAt: Date.now(),
				});
				return;
			}

			// Wakeup resumes intentionally drop the prior assistant text
			// so mid-turn failures do not resurface a stale answer as
			// if it were the new turn's output.
			let claudeSessionId: string | null = preservedClaudeSessionId;
			let lastAssistantText: string | null =
				isResumingPastRun && !isFromScheduledWakeup
					? (session0.finalAssistantText ?? null)
					: null;
			let aggregatedCostUsd = isResumingPastRun
				? (session0.totalCostUsd ?? 0)
				: 0;
			let aggregatedNumTurns = isResumingPastRun
				? (session0.totalNumTurns ?? 0)
				: 0;
			let iteration = 0;

			while (iteration < session0.maxIterations) {
				if (ac.signal.aborted) break;
				if (Date.now() - run.startedAt > session0.maxWallClockSec * 1000) {
					store.update(sessionId, {
						status: "escalated",
						phase: "escalated",
						verdictReason: "wall-clock 予算を使い切りました",
						finalAssistantText: lastAssistantText,
						claudeSessionId,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
						completedAt: Date.now(),
					});
					return;
				}

				iteration += 1;
				store.update(sessionId, {
					iteration,
					phase: "running",
				});

				const liveSession = store.get(sessionId);
				const pendingIntervention = liveSession?.pendingIntervention ?? null;
				if (pendingIntervention) {
					store.update(sessionId, { pendingIntervention: null });
				}

				const currentSession = store.get(sessionId);
				if (!currentSession) return;

				const prompt = buildIterationPrompt({
					session: currentSession,
					iteration,
					previousVerdictReason: currentSession.verdictReason ?? null,
					intervention: pendingIntervention,
					// Only the very first turn after the scheduler wakes us
					// up is a "continuation" — subsequent iterations within
					// the same runSession are normal verify-retry loops.
					// Require an actual resumable session: if the parked
					// turn never produced a parseable `session_id`,
					// claudeSessionId is null and `--resume` will not be
					// passed. In that edge case the continuation-only
					// prompt would strand Claude in a fresh conversation
					// with no task context — fall back to the full
					// iteration-1 prompt instead.
					isScheduledWakeupContinuation:
						isFromScheduledWakeup && iteration === 1 && claudeSessionId != null,
				});

				appendUserEvent(sessionId, iteration, prompt);

				const turnResult = await this.runClaudeTurn({
					sessionId,
					iteration,
					cwd: worktreePath,
					prompt,
					resumeSessionId: claudeSessionId,
					customSystemPrompt: currentSession.customSystemPrompt ?? null,
					claudeModel: currentSession.claudeModel ?? null,
					claudeEffort: currentSession.claudeEffort ?? null,
					signal: ac.signal,
					remoteControlEnabled: Boolean(currentSession.remoteControlEnabled),
					onChild: (child) => {
						run.currentChild = child;
					},
				});
				run.currentChild = null;

				if (ac.signal.aborted) return;

				if (turnResult.interrupted) {
					if (turnResult.sessionId) {
						claudeSessionId = turnResult.sessionId;
					}
					if (turnResult.result) {
						lastAssistantText = turnResult.result;
						aggregatedCostUsd += turnResult.costUsd ?? 0;
						aggregatedNumTurns += turnResult.numTurns ?? 0;
					}
					store.update(sessionId, {
						claudeSessionId,
						finalAssistantText: lastAssistantText,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
					});
					continue;
				}

				if (turnResult.error && !turnResult.result) {
					store.update(sessionId, {
						status: "failed",
						phase: "failed",
						verdictReason: turnResult.error,
						finalAssistantText: lastAssistantText,
						claudeSessionId,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
						completedAt: Date.now(),
					});
					return;
				}

				if (turnResult.sessionId) {
					claudeSessionId = turnResult.sessionId;
				}
				if (turnResult.result) {
					lastAssistantText = turnResult.result;
					aggregatedCostUsd += turnResult.costUsd ?? 0;
					aggregatedNumTurns += turnResult.numTurns ?? 0;
					store.update(sessionId, {
						claudeSessionId,
						finalAssistantText: lastAssistantText,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
					});
				}

				if (!currentSession.verifyCommand) {
					const postTurn = store.get(sessionId);
					const hasFollowUp =
						(postTurn?.pendingIntervention ?? "").trim().length > 0;
					if (hasFollowUp) {
						store.update(sessionId, {
							claudeSessionId,
							finalAssistantText: lastAssistantText,
							totalCostUsd: aggregatedCostUsd || null,
							totalNumTurns: aggregatedNumTurns || null,
						});
						continue;
					}
					if (turnResult.scheduledWakeup) {
						const waitingUntil =
							Date.now() + turnResult.scheduledWakeup.delayMs;
						store.update(sessionId, {
							status: "waiting",
							phase: "waiting",
							verdictPassed: null,
							verdictReason: null,
							finalAssistantText: lastAssistantText,
							claudeSessionId,
							totalCostUsd: aggregatedCostUsd || null,
							totalNumTurns: aggregatedNumTurns || null,
							waitingUntil,
							waitingReason: turnResult.scheduledWakeup.reason,
							completedAt: null,
						});
						appendRawEvent(
							sessionId,
							iteration,
							"system_init",
							"waiting",
							`ScheduleWakeup を検知。${Math.round(
								turnResult.scheduledWakeup.delayMs / 1000,
							)}秒後に再開します${
								turnResult.scheduledWakeup.reason
									? ` (${turnResult.scheduledWakeup.reason})`
									: ""
							}`,
						);
						return;
					}
					store.update(sessionId, {
						status: "done",
						phase: "done",
						verdictPassed: true,
						verdictReason: lastAssistantText,
						finalAssistantText: lastAssistantText,
						claudeSessionId,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
						completedAt: Date.now(),
					});
					return;
				}

				store.update(sessionId, { phase: "verifying" });
				const verdict = await runVerify(
					currentSession.verifyCommand,
					worktreePath,
					ac.signal,
				);
				if (ac.signal.aborted) return;
				appendVerifyEvent(sessionId, iteration, verdict);

				if (verdict.passed) {
					store.update(sessionId, {
						status: "done",
						phase: "done",
						verdictPassed: true,
						verdictReason:
							lastAssistantText ?? "verify コマンドが exit 0 で完了しました",
						finalAssistantText: lastAssistantText,
						claudeSessionId,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
						completedAt: Date.now(),
					});
					return;
				}

				if (
					verdict.failingTest &&
					verdict.failingTest === run.lastFailingTest
				) {
					run.consecutiveSameFailure += 1;
				} else {
					run.consecutiveSameFailure = 1;
					run.lastFailingTest = verdict.failingTest;
				}
				if (run.consecutiveSameFailure >= 3) {
					store.update(sessionId, {
						status: "escalated",
						phase: "escalated",
						verdictPassed: false,
						verdictReason: `futility: ${
							verdict.failingTest ?? "同一失敗"
						} が ${run.consecutiveSameFailure} 回連続で再現しました`,
						verdictFailingTest: verdict.failingTest,
						finalAssistantText: lastAssistantText,
						claudeSessionId,
						totalCostUsd: aggregatedCostUsd || null,
						totalNumTurns: aggregatedNumTurns || null,
						completedAt: Date.now(),
					});
					return;
				}

				store.update(sessionId, {
					verdictPassed: false,
					verdictReason: tailForReason(verdict.log),
					verdictFailingTest: verdict.failingTest,
				});
			}

			if (!ac.signal.aborted) {
				store.update(sessionId, {
					status: "escalated",
					phase: "escalated",
					verdictReason: "iteration 予算を使い切りました",
					finalAssistantText: lastAssistantText,
					claudeSessionId,
					totalCostUsd: aggregatedCostUsd || null,
					totalNumTurns: aggregatedNumTurns || null,
					completedAt: Date.now(),
				});
			}
		} finally {
			this.active.delete(sessionId);
		}
	}

	private async runClaudeTurn(params: {
		sessionId: string;
		iteration: number;
		cwd: string;
		prompt: string;
		resumeSessionId: string | null;
		customSystemPrompt: string | null;
		claudeModel: string | null;
		claudeEffort: string | null;
		signal: AbortSignal;
		onChild: (child: ChildProcess) => void;
		remoteControlEnabled: boolean;
	}): Promise<{
		result: string | null;
		sessionId: string | null;
		costUsd: number | null;
		numTurns: number | null;
		error: string | null;
		interrupted: boolean;
		scheduledWakeup: { delayMs: number; reason: string | null } | null;
	}> {
		// The PTY engine is the only path that can drive `/remote-control`.
		// We therefore dispatch to it whenever the daemon is running in
		// PTY mode OR the session asked for Remote Control — the latter
		// is a defensive fallback for when a user checks the box before
		// the env flag is set, so the feature does not silently no-op.
		if (PTY_ENGINE_ENABLED || params.remoteControlEnabled) {
			return runClaudeTurnPty({
				sessionId: params.sessionId,
				iteration: params.iteration,
				cwd: params.cwd,
				prompt: params.prompt,
				resumeSessionId: params.resumeSessionId,
				customSystemPrompt: params.customSystemPrompt,
				claudeModel: params.claudeModel,
				claudeEffort: params.claudeEffort,
				signal: params.signal,
				remoteControlEnabled: params.remoteControlEnabled,
				// The legacy caller only knows how to track a
				// ChildProcess-shaped handle. The PTY runner hands
				// back an opaque handle plus an `onExit` subscription;
				// wrap both into a shim so `abort()` and its
				// `once("close", ...)` SIGKILL-cancel path keep
				// working.
				onChild: (handle) => {
					params.onChild(buildChildProcessShim(handle));
				},
			});
		}
		return this.runClaudeTurnHeadless(params);
	}

	private runClaudeTurnHeadless(params: {
		sessionId: string;
		iteration: number;
		cwd: string;
		prompt: string;
		resumeSessionId: string | null;
		customSystemPrompt: string | null;
		claudeModel: string | null;
		claudeEffort: string | null;
		signal: AbortSignal;
		onChild: (child: ChildProcess) => void;
	}): Promise<{
		result: string | null;
		sessionId: string | null;
		costUsd: number | null;
		numTurns: number | null;
		error: string | null;
		interrupted: boolean;
		scheduledWakeup: { delayMs: number; reason: string | null } | null;
	}> {
		return new Promise((resolve) => {
			const args = [
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--permission-mode",
				"bypassPermissions",
			];
			if (params.customSystemPrompt) {
				args.push("--append-system-prompt", params.customSystemPrompt);
			}
			// Per-session Claude Code overrides. Passing `--model` /
			// `--effort` only when set keeps Claude Code's own default
			// resolution path intact for users who haven't picked one.
			//
			// Defense-in-depth whitelist: the UI already constrains
			// values via `CLAUDE_*_OPTIONS`, but that validation happens
			// on the render side. A corrupted / migrated row could still
			// persist an unexpected string. We refuse to forward anything
			// that isn't in the allow-list so the spawn call can't be
			// steered by a malformed DB value.
			if (
				params.claudeModel &&
				(CLAUDE_MODEL_OPTIONS as readonly string[]).includes(params.claudeModel)
			) {
				args.push("--model", params.claudeModel);
			} else if (params.claudeModel) {
				console.warn(
					"[todo-daemon] ignoring unknown claudeModel:",
					params.claudeModel,
				);
			}
			if (
				params.claudeEffort &&
				(CLAUDE_EFFORT_OPTIONS as readonly string[]).includes(
					params.claudeEffort,
				)
			) {
				args.push("--effort", params.claudeEffort);
			} else if (params.claudeEffort) {
				console.warn(
					"[todo-daemon] ignoring unknown claudeEffort:",
					params.claudeEffort,
				);
			}
			if (params.resumeSessionId) {
				args.push("--resume", params.resumeSessionId);
			}
			args.push(params.prompt);

			let child: ChildProcess;
			try {
				child = spawn("claude", args, {
					cwd: params.cwd,
					env: process.env,
					detached: process.platform !== "win32",
				});
			} catch (error) {
				resolve({
					result: null,
					sessionId: null,
					costUsd: null,
					numTurns: null,
					error:
						error instanceof Error
							? `claude を起動できませんでした: ${error.message}`
							: "claude を起動できませんでした",
					interrupted: false,
					scheduledWakeup: null,
				});
				return;
			}

			params.onChild(child);

			let claudeSessionId: string | null = null;
			let resultText: string | null = null;
			let costUsd: number | null = null;
			let numTurns: number | null = null;
			let errorText: string | null = null;
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let settled = false;
			let interruptedForIntervention = false;
			let scheduledWakeup: {
				delayMs: number;
				reason: string | null;
			} | null = null;

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid, "SIGINT");
				}
			};
			params.signal.addEventListener("abort", onAbort);

			const interventionPoll = setInterval(() => {
				if (settled || params.signal.aborted) {
					clearInterval(interventionPoll);
					return;
				}
				const live = getTodoSessionStore().get(params.sessionId);
				if (live?.pendingIntervention?.trim()) {
					interruptedForIntervention = true;
					clearInterval(interventionPoll);
					appendRawEvent(
						params.sessionId,
						params.iteration,
						"system_init",
						"介入",
						"ユーザ介入を検知。現在のターンを中断して介入内容で再開します…",
					);
					try {
						child.kill("SIGINT");
					} catch {
						// ignore
					}
				}
			}, 500);

			const settle = () => {
				if (settled) return;
				settled = true;
				clearInterval(interventionPoll);
				params.signal.removeEventListener("abort", onAbort);
				if (stdoutBuffer.trim().length > 0) {
					handleLine(stdoutBuffer.trim());
					stdoutBuffer = "";
				}
				resolve({
					result: resultText,
					sessionId: claudeSessionId,
					costUsd,
					numTurns,
					error: interruptedForIntervention ? null : errorText,
					interrupted: interruptedForIntervention,
					scheduledWakeup,
				});
			};

			const drainLines = (chunk: string) => {
				stdoutBuffer += chunk;
				let newlineIdx = stdoutBuffer.indexOf("\n");
				while (newlineIdx !== -1) {
					const line = stdoutBuffer.slice(0, newlineIdx).trim();
					stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
					if (line.length > 0) {
						handleLine(line);
					}
					newlineIdx = stdoutBuffer.indexOf("\n");
				}
			};

			const handleLine = (line: string) => {
				let payload: unknown;
				try {
					payload = JSON.parse(line);
				} catch {
					appendRawEvent(
						params.sessionId,
						params.iteration,
						"raw",
						"raw",
						line.slice(0, 600),
					);
					return;
				}
				const parsed = classifyStreamJson(payload);
				if (parsed.sessionId && !claudeSessionId) {
					claudeSessionId = parsed.sessionId;
				}
				if (parsed.resultText) {
					resultText = parsed.resultText;
				}
				if (parsed.costUsd != null) {
					costUsd = parsed.costUsd;
				}
				if (parsed.numTurns != null) {
					numTurns = parsed.numTurns;
				}
				if (parsed.scheduledWakeup) {
					scheduledWakeup = parsed.scheduledWakeup;
				}
				if (parsed.event) {
					getTodoSessionStore().appendStreamEvents(params.sessionId, [
						{
							id: randomUUID(),
							ts: Date.now(),
							iteration: params.iteration,
							kind: parsed.event.kind,
							label: parsed.event.label,
							text: parsed.event.text,
							toolUseId: parsed.event.toolUseId,
							parentToolUseId: parsed.event.parentToolUseId,
						},
					]);
				}
			};

			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				drainLines(chunk);
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderrBuffer += chunk;
				if (stderrBuffer.length > 16_000) {
					stderrBuffer = stderrBuffer.slice(-16_000);
				}
			});

			child.on("error", (err) => {
				if (!errorText) {
					errorText = `claude プロセスエラー: ${err.message}`;
				}
				settle();
			});
			child.on("close", (code) => {
				if (code !== 0 && !resultText && !errorText) {
					const tail = stderrBuffer.trim().split("\n").slice(-6).join("\n");
					errorText = `claude が exit code ${code} で終了しました${
						tail ? `:\n${tail}` : ""
					}`;
				}
				settle();
			});
		});
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Thin ChildProcess façade over the opaque `{ pid, kill }` handle the
 * PTY runner hands back. The supervisor only ever touches `.pid`,
 * `.kill`, and `.exitCode` / `.signalCode` on its recorded child — it
 * never reads stdout/stderr from this reference (those are consumed
 * inside the PTY runner itself). The shim stubs out the rest as a
 * minimal EventEmitter-free façade so TypeScript accepts it in place
 * of the real ChildProcess.
 */
function buildChildProcessShim(handle: {
	pid: number | null;
	kill: () => void;
	/**
	 * Register a callback the PTY runner invokes on spawn exit. The
	 * supervisor's abort path records a `once("close", ...)` listener
	 * to clear its 1.5s SIGKILL fallback timer — without an exit
	 * notification the timer always fires even when the PTY died
	 * cleanly, which is a best-effort `kill(-pid, SIGKILL)` against a
	 * potentially recycled PID (CodeRabbit review).
	 */
	onExit: (cb: () => void) => void;
}): ChildProcess {
	let killed = false;
	const closeListeners = new Set<() => void>();
	const shim = {
		pid: handle.pid ?? undefined,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill: (_signal?: NodeJS.Signals | number): boolean => {
			if (killed) return true;
			killed = true;
			try {
				handle.kill();
				shim.signalCode = "SIGTERM" as NodeJS.Signals;
			} catch {
				/* ignore */
			}
			return true;
		},
		once: (event: string, listener: (...args: unknown[]) => void) => {
			if (event === "close" || event === "exit") {
				const wrapped = () => {
					closeListeners.delete(wrapped);
					try {
						listener();
					} catch {
						/* ignore */
					}
				};
				closeListeners.add(wrapped);
			}
			return shim;
		},
		on: (event: string, listener: (...args: unknown[]) => void) => {
			if (event === "close" || event === "exit") {
				const wrapped = () => {
					try {
						listener();
					} catch {
						/* ignore */
					}
				};
				closeListeners.add(wrapped);
			}
			return shim;
		},
		off: (_event: string, _listener: (...args: unknown[]) => void) => shim,
		removeListener: (_event: string, _listener: (...args: unknown[]) => void) =>
			shim,
		removeAllListeners: (_event?: string) => shim,
		emit: (_event: string, ..._args: unknown[]) => false,
	};
	handle.onExit(() => {
		// Mark terminated so the supervisor's abort path's check
		// `child.exitCode == null && child.signalCode == null` stops
		// being universally true, and fire listeners in-order.
		if (shim.exitCode == null) shim.exitCode = 0;
		for (const cb of Array.from(closeListeners)) cb();
	});
	// The supervisor's abort path only reaches into `.pid` and `.kill()`.
	// Cast through `unknown` to sidestep the structural mismatch; the
	// shim's surface area is deliberately minimal and the daemon never
	// inspects streams on this reference.
	return shim as unknown as ChildProcess;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				detached: true,
			});
			killer.on("error", () => {
				/* best-effort */
			});
			killer.unref();
		} catch {
			// best-effort
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// ignore
		}
	}
}

/**
 * Pull attachment file paths out of description/goal markdown. Mirrors
 * the renderer regex in `TodoManager/utils/attachmentRefs` so the same
 * `todo-agent/attachments/` references the UI renders as chips are the
 * ones we surface to Claude as "please Read this". The regex is
 * duplicated intentionally — the renderer module lives in the web
 * bundle and we don't want a cross-bundle import here in the daemon.
 */
const ATTACHMENT_PATH_RE =
	/!\[[^\]]*\]\(([^()\s]*[/\\]todo-agent[/\\]attachments[/\\][^)\s]+)\)/g;

function extractAttachmentPaths(
	texts: (string | null | undefined)[],
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const text of texts) {
		if (!text) continue;
		for (const m of text.matchAll(ATTACHMENT_PATH_RE)) {
			const p = m[1];
			if (!p || seen.has(p)) continue;
			seen.add(p);
			out.push(p);
		}
	}
	return out;
}

function buildIterationPrompt(params: {
	session: SelectTodoSession;
	iteration: number;
	previousVerdictReason: string | null;
	intervention: string | null;
	isScheduledWakeupContinuation?: boolean;
}): string {
	const {
		session,
		iteration,
		previousVerdictReason,
		intervention,
		isScheduledWakeupContinuation,
	} = params;
	const goalPath = `.superset/todo/${session.id}/goal.md`;
	const goalClause = session.goal?.trim()
		? "ゴール（受け入れ条件）を達成することを目指してください"
		: "『やって欲しいこと』が完了した時点で完了とみなしてください";

	const sections: string[] = [];
	if (isScheduledWakeupContinuation) {
		// Claude paused itself via `ScheduleWakeup` and the scheduler
		// has now woken it up. The original goal and custom system
		// prompt are already present in the resumed conversation — do
		// not re-send them verbatim, that duplicate prompt is the
		// "ゴリ押し" complaint in issue #240. A short continuation cue
		// is enough; the user-visible intervention (if any) is still
		// routed through the normal channel below.
		sections.push(
			"(予定時刻になりました。前回の続きから作業を再開してください。)",
		);
	} else if (iteration === 1) {
		if (session.customSystemPrompt?.trim()) {
			sections.push(
				`ユーザー設定のシステム指示（最優先で遵守）:\n${session.customSystemPrompt.trim()}`,
			);
		}
		sections.push(
			`${goalPath} を読んで、${goalClause}。作業ディレクトリは worktree のルートです。`,
		);
		sections.push(
			`タスクのタイトル: ${session.title}\n説明: ${session.description}`,
		);
		if (session.goal?.trim()) {
			sections.push(`ゴール:\n${session.goal.trim()}`);
		}
		// Hoist attachment file paths out of the markdown so Claude
		// doesn't have to decide on its own whether `![](…)` inside the
		// description is decorative or a real artifact it should load.
		// Before this nudge, image attachments were frequently ignored —
		// the file was saved and the path was correct, but Claude would
		// proceed without ever calling Read on it. See #247.
		const attachments = extractAttachmentPaths([
			session.description,
			session.goal,
		]);
		if (attachments.length > 0) {
			sections.push(
				[
					"添付ファイル（作業開始前に Read で内容を確認してください）:",
					...attachments.map((p) => `- ${p}`),
				].join("\n"),
			);
		}
	} else {
		sections.push(
			`イテレーション ${iteration} です。前回の verify は失敗しました。`,
		);
		if (previousVerdictReason) {
			sections.push(`前回の verify 結果:\n${previousVerdictReason}`);
		}
		sections.push(`${goalPath} を読み直し、${goalClause}。`);
	}
	if (intervention) {
		sections.push(`ユーザーからの介入指示（優先度: 高）:\n${intervention}`);
	}
	if (session.verifyCommand && !isScheduledWakeupContinuation) {
		sections.push(
			`完了判定: 作業が終わったら、セッション終了後に supervisor が \`${session.verifyCommand}\` を実行して exit 0 を要求します。`,
		);
	}
	return sections.join("\n\n");
}

function tailForReason(log: string): string {
	const tail = log.trim().split("\n").slice(-20).join("\n");
	return tail.length > 2000 ? tail.slice(-2000) : tail;
}

interface VerifyResult {
	passed: boolean;
	log: string;
	failingTest?: string;
}

function runVerify(
	verifyCommand: string,
	cwd: string,
	signal: AbortSignal,
): Promise<VerifyResult> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", verifyCommand], {
			cwd,
			env: process.env,
			signal,
		});
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d.toString();
		});
		child.stderr.on("data", (d) => {
			buf += d.toString();
		});
		child.on("error", (err) => {
			resolve({ passed: false, log: `${err.message}\n${buf}` });
		});
		child.on("close", (code) => {
			const passed = code === 0;
			resolve({
				passed,
				log: buf,
				failingTest: passed ? undefined : guessFailingTest(buf),
			});
		});
	});
}

function guessFailingTest(log: string): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes from verify output is the whole point
	const stripAnsi = log.replace(/\u001B\[[0-9;]*m/g, "");
	const lines = stripAnsi.split("\n");
	const patterns: RegExp[] = [
		/^\s*\(fail\)\s+(.+?)(?:\s+\[\d.*)?$/i,
		/^\s*❯\s+(.+?)(?:\s+\d+ms)?$/,
		/^\s*FAIL\s+(.+?)(?:\s+>\s+.+)?$/,
		/^\s*✕\s+(.+?)(?:\s+\(\d+\s*ms\))?$/,
		/^\s*×\s+(.+?)(?:\s+\(\d+\s*ms\))?$/,
		/^\s*✗\s+(.+?)(?:\s+\(\d+\s*ms\))?$/,
		/^\s*not ok \d+\s*-\s*(.+)$/,
		/^\s*\d+\)\s+(?:\[[^\]]+\]\s+)?[›»>]\s+(.+)$/,
	];
	for (const line of lines) {
		for (const re of patterns) {
			const m = line.match(re);
			if (m?.[1]) return normalizeTestId(m[1]);
		}
	}
	const errorLine = lines.find((l) => /\b(Error|Assertion)\b.*:/.test(l));
	if (errorLine) return normalizeTestId(errorLine.trim());
	return undefined;
}

function normalizeTestId(raw: string): string {
	return raw
		.trim()
		.replace(/\s*\(\d+\s*ms\)\s*$/, "")
		.replace(/\s*\[\d+(?:\.\d+)?\s*m?s\]\s*$/, "")
		.replace(/@0x[0-9a-f]+/gi, "@0x?")
		.replace(/:\s*expected.*$/i, "")
		.slice(0, 240);
}

// ----- stream-json parsing ---------------------------------------------------

interface ClassifiedEvent {
	kind: TodoStreamEventKind;
	label: string;
	text: string;
	toolUseId?: string;
	parentToolUseId?: string;
}

interface ClassifiedLine {
	sessionId: string | null;
	resultText: string | null;
	costUsd: number | null;
	numTurns: number | null;
	event: ClassifiedEvent | null;
	scheduledWakeup: { delayMs: number; reason: string | null } | null;
}

function classifyStreamJson(payload: unknown): ClassifiedLine {
	const empty: ClassifiedLine = {
		sessionId: null,
		resultText: null,
		costUsd: null,
		numTurns: null,
		event: null,
		scheduledWakeup: null,
	};
	if (typeof payload !== "object" || payload === null) return empty;
	const rec = payload as Record<string, unknown>;
	const type = typeof rec.type === "string" ? (rec.type as string) : "";
	const sessionId =
		typeof rec.session_id === "string" ? (rec.session_id as string) : null;
	const parentToolUseId =
		typeof rec.parent_tool_use_id === "string"
			? (rec.parent_tool_use_id as string)
			: undefined;

	if (type === "system" && rec.subtype === "init") {
		return {
			...empty,
			sessionId,
			event: {
				kind: "system_init",
				label: "init",
				text: `session ${sessionId ?? "?"} 準備完了`,
			},
		};
	}

	if (type === "assistant") {
		const text = extractAssistantText(rec.message);
		const tool = extractToolUseSummary(rec.message);
		const wakeup = extractScheduledWakeup(rec.message);
		if (text) {
			return {
				...empty,
				sessionId,
				event: {
					kind: "assistant_text",
					label: "Claude",
					text,
					parentToolUseId,
				},
				scheduledWakeup: wakeup,
			};
		}
		if (tool) {
			return {
				...empty,
				sessionId,
				event: {
					kind: "tool_use",
					label: tool.label,
					text: tool.text,
					toolUseId: tool.id,
					parentToolUseId,
				},
				scheduledWakeup: wakeup,
			};
		}
		return empty;
	}

	if (type === "user") {
		const result = extractToolResultDetails(rec.message);
		if (result) {
			return {
				...empty,
				sessionId,
				event: {
					kind: "tool_result",
					label: "tool result",
					text: truncate(result.text, 400),
					toolUseId: result.toolUseId,
					parentToolUseId,
				},
			};
		}
		return empty;
	}

	if (type === "result") {
		const resultText =
			typeof rec.result === "string" ? (rec.result as string) : null;
		const costUsd =
			typeof rec.total_cost_usd === "number"
				? (rec.total_cost_usd as number)
				: null;
		const numTurns =
			typeof rec.num_turns === "number" ? (rec.num_turns as number) : null;
		return {
			sessionId,
			resultText,
			costUsd,
			numTurns,
			event: {
				kind: "result",
				label: "result",
				text: resultText ?? "（空の結果）",
			},
			scheduledWakeup: null,
		};
	}

	if (
		type === "error" ||
		(typeof rec.subtype === "string" && rec.subtype === "error")
	) {
		const message =
			typeof rec.error === "string"
				? (rec.error as string)
				: JSON.stringify(rec).slice(0, 400);
		return {
			...empty,
			sessionId,
			event: { kind: "error", label: "error", text: message },
		};
	}

	return empty;
}

function extractAssistantText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string") {
			parts.push(rec.text as string);
		}
	}
	const joined = parts.join("").trim();
	return joined.length > 0 ? joined : null;
}

function extractToolUseSummary(
	message: unknown,
): { label: string; text: string; id: string | undefined } | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type !== "tool_use") continue;
		const name = typeof rec.name === "string" ? (rec.name as string) : "tool";
		const id = typeof rec.id === "string" ? (rec.id as string) : undefined;
		const input = rec.input;
		const inputSummary = summarizeToolInput(name, input);
		return { label: name, text: inputSummary, id };
	}
	return null;
}

function extractScheduledWakeup(
	message: unknown,
): { delayMs: number; reason: string | null } | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type !== "tool_use") continue;
		if (rec.name !== "ScheduleWakeup") continue;
		const input = rec.input;
		if (typeof input !== "object" || input === null) continue;
		const inp = input as Record<string, unknown>;
		const delaySeconds =
			typeof inp.delaySeconds === "number"
				? (inp.delaySeconds as number)
				: null;
		if (delaySeconds == null || !Number.isFinite(delaySeconds)) continue;
		const seconds = Math.floor(delaySeconds);
		if (seconds < 60 || seconds > 3600) continue;
		const reason =
			typeof inp.reason === "string" ? (inp.reason as string) : null;
		return { delayMs: seconds * 1000, reason };
	}
	return null;
}

function extractToolResultDetails(
	message: unknown,
): { text: string; toolUseId: string | undefined } | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	let toolUseId: string | undefined;
	let sawToolResult = false;
	let imageCount = 0;
	let otherBlockCount = 0;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type === "tool_result") {
			sawToolResult = true;
			if (!toolUseId && typeof rec.tool_use_id === "string") {
				toolUseId = rec.tool_use_id as string;
			}
			const inner = rec.content;
			if (typeof inner === "string") {
				parts.push(inner);
			} else if (Array.isArray(inner)) {
				for (const p of inner) {
					if (typeof p !== "object" || p === null) continue;
					const pr = p as Record<string, unknown>;
					if (pr.type === "text" && typeof pr.text === "string") {
						parts.push(pr.text as string);
					} else if (pr.type === "image") {
						imageCount += 1;
					} else if (typeof pr.type === "string") {
						otherBlockCount += 1;
					}
				}
			}
		}
	}
	// Bail only when the message didn't contain a tool_result block at
	// all. If it did, emit the result even when it carried no text so
	// the UI can pair it with its tool_use — otherwise e.g. Read on an
	// image file (which returns only `image` blocks) leaves the card
	// spinning "実行中…" forever even though Claude already processed
	// the result and moved on to subsequent tool calls. See #247.
	if (!sawToolResult) return null;
	const joined = parts.join("\n").trim();
	if (joined.length > 0) return { text: joined, toolUseId };
	const summary: string[] = [];
	if (imageCount > 0) {
		summary.push(imageCount === 1 ? "[画像 1 件]" : `[画像 ${imageCount} 件]`);
	}
	if (otherBlockCount > 0) {
		summary.push(`[非テキストブロック ${otherBlockCount} 件]`);
	}
	return {
		text: summary.length > 0 ? summary.join(" ") : "(空の結果)",
		toolUseId,
	};
}

function summarizeToolInput(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) {
		return name;
	}
	const rec = input as Record<string, unknown>;
	const key =
		typeof rec.command === "string"
			? (rec.command as string)
			: typeof rec.file_path === "string"
				? (rec.file_path as string)
				: typeof rec.path === "string"
					? (rec.path as string)
					: typeof rec.pattern === "string"
						? (rec.pattern as string)
						: typeof rec.description === "string"
							? (rec.description as string)
							: null;
	return key ? truncate(`${name}: ${key}`, 300) : name;
}

function truncate(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}…`;
}

function appendSetupEvent(
	sessionId: string,
	label: string,
	text: string,
): void {
	getTodoSessionStore().appendStreamEvents(sessionId, [
		{
			id: randomUUID(),
			ts: Date.now(),
			iteration: 0,
			kind: "system_init",
			label,
			text,
		},
	]);
}

function appendUserEvent(
	sessionId: string,
	iteration: number,
	prompt: string,
): void {
	getTodoSessionStore().appendStreamEvents(sessionId, [
		{
			id: randomUUID(),
			ts: Date.now(),
			iteration,
			kind: "raw",
			label:
				iteration === 1 ? "最初のプロンプト" : `イテレーション ${iteration}`,
			text: truncate(prompt, 4000),
		},
	]);
}

function appendVerifyEvent(
	sessionId: string,
	iteration: number,
	verdict: VerifyResult,
): void {
	getTodoSessionStore().appendStreamEvents(sessionId, [
		{
			id: randomUUID(),
			ts: Date.now(),
			iteration,
			kind: verdict.passed ? "result" : "error",
			label: verdict.passed ? "verify pass" : "verify fail",
			text: truncate(verdict.log || "(no output)", 1200),
		},
	]);
}

function appendRawEvent(
	sessionId: string,
	iteration: number,
	kind: TodoStreamEventKind,
	label: string,
	text: string,
): void {
	getTodoSessionStore().appendStreamEvents(sessionId, [
		{
			id: randomUUID(),
			ts: Date.now(),
			iteration,
			kind,
			label,
			text,
		},
	]);
}
