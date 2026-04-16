import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SelectTodoSession } from "@superset/local-db";
import { getCurrentHeadSha } from "main/todo-agent/git-status";
import {
	getTodoSessionStore,
	resolveWorktreePath,
} from "main/todo-agent/session-store";
import { getTodoSettings } from "main/todo-agent/settings";
import type { TodoStreamEventKind } from "main/todo-agent/types";

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

	listActiveSessionIds(): string[] {
		return Array.from(this.active.keys());
	}

	async start(sessionId: string): Promise<void> {
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

		const isResumingPastRun = !!session0.claudeSessionId;
		if (!isResumingPastRun) {
			store.clearStreamEvents(sessionId);
		}
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
