import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelectTodoSession } from "@superset/local-db";
import { getCurrentHeadSha } from "./git-status";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { getTodoSettings } from "./settings";
import type { TodoStreamEventKind } from "./types";
import { TODO_ARTIFACT_SUBDIR } from "./types";

/**
 * Headless Claude Code driver for TODO autonomous sessions.
 *
 * The previous iteration drove interactive Claude Code through a real PTY
 * and tried to detect turn completion with an idle heuristic. That was
 * fundamentally unreliable (long-thinking Claude looked identical to a
 * dead claude), and the PTY leaked into the workspace tab bar. This
 * rewrite replaces the PTY with `claude -p --output-format stream-json`:
 *
 *   - The child process is spawned by the main process (no PTY, no tab
 *     bar involvement, no hidden-tab hacks).
 *   - Completion is **process exit**. No idle heuristic. No guessing.
 *   - The `result` NDJSON event carries `result` (the final assistant
 *     text), `session_id`, `total_cost_usd`, and `num_turns`, which are
 *     stored on the DB row so the Manager can show a real verdict and
 *     timing information.
 *   - Retry iterations use `--resume <session_id>` so the same
 *     conversation state is preserved across verify failures.
 *   - Per-turn stream events are appended to an in-memory ring buffer
 *     and fanned out over a tRPC subscription so the Manager detail
 *     pane shows a live, chat-like view of the worker's activity.
 *
 * `--bare` is deliberately NOT passed. The `--bare` flag forces
 * `ANTHROPIC_API_KEY` and explicitly refuses OAuth/keychain reads,
 * which would break users authenticated via Claude Max. We still gain
 * reproducibility because we own every argument and the CLAUDE.md
 * discovery just adds project context, not hooks we do not want.
 */
interface ActiveRun {
	sessionId: string;
	abortController: AbortController;
	lastFailingTest?: string;
	consecutiveSameFailure: number;
	startedAt: number;
	currentChild: ChildProcess | null;
}

class TodoSupervisor {
	/**
	 * Currently executing sessions keyed by sessionId. The size of this map
	 * is compared against `maxConcurrentTasks` in `drain()` to decide whether
	 * the next pending session can start. Keyed storage (as opposed to a
	 * single slot) lets `abort()` target a specific run without scanning.
	 */
	private readonly active = new Map<string, ActiveRun>();
	private readonly queue: string[] = [];

	/**
	 * Pre-compute the artifact directory path for a not-yet-inserted
	 * session. Called from the `create` mutation BEFORE the row is
	 * written so the DB insert can land the final absolute path in one
	 * shot — no more two-step `PENDING` → update dance, no more
	 * half-written rows left behind by a crash between the two steps.
	 */
	computeArtifactPath(params: {
		sessionId: string;
		workspaceId: string;
	}): string {
		const worktreePath = resolveWorktreePath(params.workspaceId);
		if (!worktreePath) {
			throw new Error(
				`todo-agent: workspace ${params.workspaceId} has no resolvable path`,
			);
		}
		return path.join(worktreePath, TODO_ARTIFACT_SUBDIR, params.sessionId);
	}

	/**
	 * Materialize the artifact directory and write the initial goal.md.
	 * Called right after insert. Idempotent — safe to call on rerun.
	 */
	prepareArtifacts(session: SelectTodoSession): string {
		const dir = session.artifactPath;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "goal.md"), renderGoalDoc(session), "utf8");
		return dir;
	}

	async start(sessionId: string): Promise<void> {
		// Already pending another launch — coalesce repeat clicks.
		if (this.queue.includes(sessionId)) return;
		// If a previous run is still active AND has not been aborted,
		// ignore — repeated start clicks should not duplicate work.
		const active = this.active.get(sessionId);
		if (active && !active.abortController.signal.aborted) return;
		// Either no active run, or the active run has already been
		// aborted and is just tearing down (typical right after abort:
		// the trpc-router flips status to `preparing` and calls us, but
		// `runSession`'s finally has not yet removed the entry from
		// `active`). Queue the restart so drain() picks it up the
		// moment the slot frees — returning early here would silently
		// drop the request and leave the session stuck in `preparing`.
		this.queue.push(sessionId);
		this.drain();
	}

	/**
	 * Called by the settings mutation after `maxConcurrentTasks` changes.
	 * When the user raises the concurrency cap we need to pull the next
	 * pending sessions from the queue immediately — otherwise they sit
	 * idle until the currently active session completes, which is the
	 * exact symptom reported in issue #220. Lowering the cap is handled
	 * passively (new starts are blocked until capacity frees up; already
	 * running sessions keep running).
	 */
	handleSettingsChanged(): void {
		this.drain();
	}

	/**
	 * Launch as many queued sessions as `maxConcurrentTasks` permits.
	 * Synchronous: each launch kicks off `runSession` as a fire-and-
	 * forget Promise whose `finally` loops back into `drain()` so the
	 * next slot fills as soon as a session finishes. The settings value
	 * is re-read on every call so live setting updates take effect
	 * without restart.
	 */
	private drain(): void {
		const capacity = getTodoSettings().maxConcurrentTasks;
		while (this.active.size < capacity && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) continue;
			// A session can be aborted / deleted / rerun while still
			// waiting in the queue. Re-check its latest persisted status
			// before actually running it so we never revive an already
			// terminal session into execution.
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
			// `runSession` sets `this.active[sessionId]` synchronously
			// before its first `await`, so by the time control returns
			// here the slot count reflects the new run and the while
			// loop's capacity check stays accurate.
			void this.runSession(next)
				.catch((err) => {
					console.warn(
						`[todo-supervisor] runSession crashed for ${next}:`,
						err,
					);
				})
				.finally(() => {
					this.drain();
				});
		}
	}

	abort(sessionId: string): void {
		const store = getTodoSessionStore();
		// If the session is still waiting in the pending queue, drop it
		// from there so the drain loop does not silently revive it once
		// the active run finishes.
		const queueIdx = this.queue.indexOf(sessionId);
		if (queueIdx !== -1) {
			this.queue.splice(queueIdx, 1);
		}
		const activeRun = this.active.get(sessionId);
		if (activeRun) {
			activeRun.abortController.abort();
			// Kill the whole process group, not just the direct child.
			// `claude -p` spawns its own children (the Node-side agent
			// loop, MCP servers, tool helpers). A plain `child.kill()`
			// on the wrapper only signals the wrapper, leaving the
			// grandchildren alive and still talking to the Anthropic
			// API — the exact symptom users hit when Stop doesn't
			// actually stop. We `spawn` with `detached: true` so the
			// child becomes a session leader; here we signal the
			// negative PID to reach every descendant.
			const child = activeRun.currentChild;
			if (child?.pid) {
				const pid = child.pid;
				killProcessTree(pid, "SIGINT");
				// Use an exit-aware guard instead of `child.killed`.
				// `killProcessTree` signals via `process.kill(-pid, ...)`
				// so the node `ChildProcess` never flips its `killed`
				// flag and `child.killed` alone would make us blindly
				// SIGKILL 1.5s later even if the process already exited
				// cleanly — a reused pid could then receive the signal.
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

	/**
	 * Queue a free-form user intervention that will be prepended to the
	 * next turn's prompt. In the headless architecture we cannot inject
	 * mid-stream, so interventions land at the next turn boundary.
	 */
	queueIntervention(sessionId: string, data: string): void {
		const store = getTodoSessionStore();
		const existing = store.get(sessionId);
		if (!existing) return;
		const previous = existing.pendingIntervention?.trim();
		const next = [previous, data.trim()].filter(Boolean).join("\n\n");
		store.update(sessionId, { pendingIntervention: next });
	}

	// ---- internals ----

	private async runSession(sessionId: string): Promise<void> {
		const store = getTodoSessionStore();
		const session0 = store.get(sessionId);
		if (!session0) return;

		// A session that already completed at least one run keeps its
		// previous stream events so the user can scroll back to the
		// prior turns after sending a follow-up message (done→resume).
		// Without a `claudeSessionId` this is the very first run of
		// this session, so wipe the (probably stale) buffer to match
		// a clean-slate UX.
		const isResumingPastRun = !!session0.claudeSessionId;
		if (!isResumingPastRun) {
			store.clearStreamEvents(sessionId);
		}
		// Prime the artifact-path cache so the hot stream-persist path
		// does not need to do a synchronous SQLite read per event.
		store.setArtifactPathCache(sessionId, session0.artifactPath);
		if (isResumingPastRun) {
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
			// Capture the git HEAD at session start so the Manager's right
			// sidebar can show exactly what this session produced via
			// `git log <startHeadSha>..HEAD` — user commits made before
			// the session are excluded from attribution.
			//
			// On resume (follow-up intervention), keep the ORIGINAL
			// starting point. Overwriting it on every run moved the
			// goalpost forward and hid earlier commits from the sidebar.
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
			appendSetupEvent(
				sessionId,
				"Claude",
				"claude -p --output-format stream-json を起動します",
			);

			// When resuming a previously-completed session (done/failed/
			// aborted/escalated + follow-up message), keep the existing
			// Claude session id so the next iteration issues
			// `--resume <id>` and actually continues the conversation.
			// Wiping it to null here made the UI label it "再開" while
			// Claude silently started fresh.
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
				// Keep the prior assistant text on resume so the Manager
				// shows the last known answer while the new turn streams.
				finalAssistantText: isResumingPastRun
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
				// Clear any prior ScheduleWakeup parking fields — we are
				// actively running again, whether this run was kicked off
				// by the scheduler waking us up or by a manual resume.
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

			// Same resume reasoning as above — seed the loop-local vars
			// from the persisted row so `--resume` is actually issued.
			let claudeSessionId: string | null = preservedClaudeSessionId;
			let lastAssistantText: string | null = isResumingPastRun
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

				// Read-then-clear pending intervention at the turn boundary
				// so user-queued steering actually reaches Claude.
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
				});

				appendUserEvent(sessionId, iteration, prompt);

				const turnResult = await this.runClaudeTurn({
					sessionId,
					iteration,
					cwd: worktreePath,
					prompt,
					resumeSessionId: claudeSessionId,
					customSystemPrompt: currentSession.customSystemPrompt ?? null,
					signal: ac.signal,
					onChild: (child) => {
						run.currentChild = child;
					},
				});
				run.currentChild = null;

				if (ac.signal.aborted) return;

				// The turn was interrupted because the user queued a
				// mid-turn intervention. Preserve whatever session_id
				// we already captured and loop back so the next
				// iteration picks up the intervention via the normal
				// read-then-clear path. No error, no status change —
				// the session stays running.
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

				// No verify → single-turn mode by default. But if the user
				// queued an intervention between "Claude finished iteration
				// N" and "we decide to end", we must not declare done —
				// otherwise the intervention sits in `pendingIntervention`
				// forever and the UI shows "予約済み" while Claude never
				// sees it. Loop another iteration so the next turn picks it
				// up (same mechanism verify-mode already uses).
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
					// Claude parked itself via `ScheduleWakeup` — park the
					// session in `waiting` instead of declaring it done, and
					// let the scheduler tick wake it back up when the deadline
					// passes. `completedAt` stays null so cleanup / retention
					// never deletes a paused session, and the scheduler keeps
					// counting it against the concurrency budget.
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
				// If the user aborted while verify was running, bail out
				// BEFORE we write any verdict state. Otherwise the aborted
				// session would be tainted with "verify failed: AbortError…"
				// even though verify was never allowed to finish.
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

				// Futility: same failing test 3 iterations in a row → escalate
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

			// Only write the "iteration budget exhausted" verdict if we
			// left the loop cleanly. If the user aborted, `abort()` has
			// already written `status: "aborted"` and we must not
			// overwrite it. Without this guard, a race between the abort
			// signal and the final DB write mislabels aborted sessions
			// as escalated with a wrong reason.
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

	private runClaudeTurn(params: {
		sessionId: string;
		iteration: number;
		cwd: string;
		prompt: string;
		resumeSessionId: string | null;
		customSystemPrompt: string | null;
		signal: AbortSignal;
		onChild: (child: ChildProcess) => void;
	}): Promise<{
		result: string | null;
		sessionId: string | null;
		costUsd: number | null;
		numTurns: number | null;
		error: string | null;
		/** True when the turn was interrupted because the user queued
		 *  a mid-turn intervention, NOT because of an external abort. */
		interrupted: boolean;
		/**
		 * Latest `ScheduleWakeup` (or equivalent self-pacing) call observed
		 * during the turn. Null when Claude never asked to wait. The
		 * supervisor uses this to park the session in the `waiting`
		 * status instead of treating `child exit` as completion.
		 */
		scheduledWakeup: { delayMs: number; reason: string | null } | null;
	}> {
		return new Promise((resolve) => {
			const args = [
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				// `bypassPermissions` is required for truly unattended
				// headless runs. `acceptEdits` auto-approves Edit/Write
				// but still prompts for Bash tool calls; in `-p` mode
				// there is nobody to grant that approval, so the child
				// would hang forever waiting for a prompt that never
				// comes, leaving the session stuck in `running` state.
				// TODO agent is a deliberate-use feature where the user
				// already opted into full autonomy, so bypassing all
				// permission checks is the right default here.
				"--permission-mode",
				"bypassPermissions",
			];
			if (params.customSystemPrompt) {
				args.push("--append-system-prompt", params.customSystemPrompt);
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
					// Make the child a session / process-group leader so
					// `abort()` can signal the whole tree via negative PID.
					// Without this, killing only the direct child leaves
					// claude's own subprocesses (MCP servers, tool
					// helpers) alive, which is exactly the "Stop doesn't
					// stop" bug users hit.
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

			// Poll for mid-turn interventions every 500ms. When the
			// user queues a message while Claude is mid-stream, we
			// SIGINT the child immediately so the while loop can
			// resume the same session with the intervention as the
			// next user prompt — giving "interrupt anytime" UX
			// instead of waiting for the full turn to finish.
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

			// Single-shot settlement. `child.on("error", ...)` can fire
			// WITHOUT a subsequent `close` (e.g. ENOENT when the claude
			// binary is missing from PATH), and without this guard the
			// outer promise would hang forever and the session would get
			// stuck in `running`. Both the error and close handlers now
			// funnel through this helper.
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
				// Spawn failures (ENOENT, EACCES) reach us via this event,
				// often WITHOUT a follow-up `close`. Settle eagerly.
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

let supervisor: TodoSupervisor | undefined;
export function getTodoSupervisor(): TodoSupervisor {
	if (!supervisor) supervisor = new TodoSupervisor();
	return supervisor;
}

// ---- helpers ----

/**
 * Kill a process and every descendant it spawned. On POSIX this
 * uses the negative PID trick to signal the whole process group
 * (requires the child to have been spawned with `detached: true`
 * so it is a session leader). On Windows we fall back to
 * `taskkill /T /F` via the synchronous child_process API.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			// Async spawn so we never block Electron's main thread on a
			// slow taskkill (large tool trees can take noticeable time
			// to unwind). Detach + unref so node does not wait on it.
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				detached: true,
			});
			killer.on("error", () => {
				/* ignore — best-effort */
			});
			killer.unref();
		} catch {
			// ignore — best-effort
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// Process group might already be gone (e.g. the child exited
		// on its own between the check and the signal). Try the
		// direct pid as a fallback so we still kill the wrapper if it
		// is the only thing still alive.
		try {
			process.kill(pid, signal);
		} catch {
			// ignore
		}
	}
}

function renderGoalDoc(session: SelectTodoSession): string {
	const lines: string[] = [
		`# TODO: ${session.title}`,
		"",
		"## やって欲しいこと",
		session.description,
		"",
		"## ゴール（受け入れ条件）",
		session.goal?.trim() ||
			"（未指定。上記『やって欲しいこと』が完了した時点で完了とみなす）",
		"",
	];
	if (session.verifyCommand) {
		lines.push(
			"## Verify コマンド",
			"```sh",
			session.verifyCommand,
			"```",
			"",
			`予算: ${session.maxIterations} イテレーション / ${session.maxWallClockSec} 秒`,
			"",
		);
	} else {
		lines.push(
			"## モード",
			"単発タスク。外部 verify は行いません。ゴールを達成したと判断したらターンを終えて停止してください。",
			"",
		);
	}
	return lines.join("\n");
}

function buildIterationPrompt(params: {
	session: SelectTodoSession;
	iteration: number;
	previousVerdictReason: string | null;
	intervention: string | null;
}): string {
	const { session, iteration, previousVerdictReason, intervention } = params;
	const goalPath = `.superset/todo/${session.id}/goal.md`;
	const goalClause = session.goal?.trim()
		? "ゴール（受け入れ条件）を達成することを目指してください"
		: "『やって欲しいこと』が完了した時点で完了とみなしてください";

	const sections: string[] = [];
	if (iteration === 1) {
		// Mirror the preset / custom system prompt into the first turn's
		// user message. `--append-system-prompt` alone was not always
		// visibly honored (users reported "気がする" that Claude never
		// read the template). Duplicating it as explicit steering at the
		// top of the prompt guarantees delivery and is cheap — Claude
		// tolerates the same guidance appearing twice.
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
	if (session.verifyCommand) {
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

// ---- stream-json parsing ----

interface ClassifiedEvent {
	kind: TodoStreamEventKind;
	label: string;
	text: string;
	/**
	 * For `tool_use` events this is the tool_use block id.
	 * For `tool_result` events this is the `tool_use_id` the result
	 * targets. Undefined for non-tool events.
	 */
	toolUseId?: string;
	/**
	 * Set when the NDJSON record has a top-level `parent_tool_use_id`,
	 * i.e. the message was emitted from inside a subagent (Agent/Task
	 * tool) context.
	 */
	parentToolUseId?: string;
}

interface ClassifiedLine {
	sessionId: string | null;
	resultText: string | null;
	costUsd: number | null;
	numTurns: number | null;
	event: ClassifiedEvent | null;
	/**
	 * Non-null when this line carried a Claude self-pacing call — currently
	 * `ScheduleWakeup`, the /loop dynamic-mode primitive. The supervisor
	 * propagates this out of the turn so a subsequent `child exit` event
	 * parks the session in the `waiting` status instead of flipping it to
	 * `done` and losing it from the concurrency count.
	 */
	scheduledWakeup: { delayMs: number; reason: string | null } | null;
}

/**
 * Reduce one NDJSON record emitted by `claude -p --output-format stream-json`
 * into the condensed event our UI wants, plus any scalar fields we promote
 * to DB columns. The Claude Code stream is stable enough to key on but we
 * defensively handle unknown shapes by falling through to a `raw` event.
 */
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
	// Claude Code sets `parent_tool_use_id` on the top-level NDJSON
	// record whenever the message was emitted inside a subagent
	// context (i.e. the main session invoked the Task/Agent tool).
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
		// Extract text, tool_use, and scheduled wakeup up front so a
		// message that carries both "here's what I'm doing" text AND a
		// `ScheduleWakeup` tool_use in the same content array still
		// propagates the wakeup. The previous early-return on text
		// silently dropped ScheduleWakeup in the mixed case, which made
		// the supervisor mark the session as `done` the moment the
		// child exited instead of parking it in `waiting`.
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

/**
 * Look for a `ScheduleWakeup` tool_use in the assistant message. This is
 * the /loop-mode primitive Claude uses to park itself until a deadline
 * (e.g. "re-check CI in 5 minutes"). In headless mode Claude still
 * surfaces the same tool_use in the stream and then exits, so detecting
 * the call here is what lets the supervisor distinguish "work really
 * finished" from "work paused itself" — without this, the session flips
 * to `done` on child exit and disappears from the concurrency count.
 */
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
		// Clamp to match the ScheduleWakeup contract [60, 3600]s — a stray
		// value outside this range is a malformed call, not a wait request.
		const clamped = Math.max(60, Math.min(3600, Math.floor(delaySeconds)));
		const reason =
			typeof inp.reason === "string" ? (inp.reason as string) : null;
		return { delayMs: clamped * 1000, reason };
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
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type === "tool_result") {
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
					}
				}
			}
		}
	}
	const joined = parts.join("\n").trim();
	if (joined.length === 0) return null;
	return { text: joined, toolUseId };
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

// Hash helper (not currently used, kept for future `id` fallbacks when
// randomUUID is unavailable).
export function __hashId(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 8);
}
