import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelectTodoSession } from "@superset/local-db";
import { getCurrentHeadSha } from "./git-status";
import {
	getTodoSessionStore,
	resolveWorktreePath,
} from "./session-store";
import type { TodoStreamEvent, TodoStreamEventKind } from "./types";
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
	private active: ActiveRun | undefined;
	private readonly queue: string[] = [];

	prepareArtifacts(session: SelectTodoSession): string {
		const worktreePath = resolveWorktreePath(session.workspaceId);
		if (!worktreePath) {
			throw new Error(
				`todo-agent: workspace ${session.workspaceId} has no resolvable path`,
			);
		}
		const dir = path.join(
			worktreePath,
			TODO_ARTIFACT_SUBDIR,
			session.id,
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "goal.md"),
			renderGoalDoc(session),
			"utf8",
		);
		return dir;
	}

	async start(sessionId: string): Promise<void> {
		if (this.active) {
			if (!this.queue.includes(sessionId)) this.queue.push(sessionId);
			return;
		}
		await this.runSession(sessionId);
		while (this.queue.length > 0) {
			const next = this.queue.shift();
			if (next) await this.runSession(next);
		}
	}

	abort(sessionId: string): void {
		const store = getTodoSessionStore();
		if (this.active?.sessionId === sessionId) {
			this.active.abortController.abort();
			// Send SIGINT first (clean shutdown), then SIGKILL as a safety
			// net via a short timer so we never leak a runaway child.
			const child = this.active.currentChild;
			if (child && !child.killed) {
				try {
					child.kill("SIGINT");
				} catch {
					// ignore
				}
				setTimeout(() => {
					if (child && !child.killed) {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
					}
				}, 1500);
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

		// Fresh in-memory buffer for this run. Old events from previous
		// runs of the same session are cleared so the UI sees just the
		// current attempt.
		store.clearStreamEvents(sessionId);

		const ac = new AbortController();
		const run: ActiveRun = {
			sessionId,
			abortController: ac,
			consecutiveSameFailure: 0,
			startedAt: Date.now(),
			currentChild: null,
		};
		this.active = run;

		try {
			appendSetupEvent(sessionId, "セットアップ", "ワークスペースを解決しています…");
			const worktreePath = resolveWorktreePath(session0.workspaceId);
			// Capture the git HEAD at session start so the Manager's right
			// sidebar can show exactly what this session produced via
			// `git log <startHeadSha>..HEAD` — user commits made before
			// the session are excluded from attribution.
			if (worktreePath) {
				appendSetupEvent(sessionId, "worktree", worktreePath);
			}
			const startHeadSha = worktreePath
				? await getCurrentHeadSha(worktreePath)
				: null;
			if (startHeadSha) {
				appendSetupEvent(
					sessionId,
					"開始時 HEAD",
					`${startHeadSha.slice(0, 12)}`,
				);
			}
			if (session0.verifyCommand) {
				appendSetupEvent(
					sessionId,
					"verify",
					session0.verifyCommand,
				);
			} else {
				appendSetupEvent(
					sessionId,
					"モード",
					"単発タスク（外部 verify なし）",
				);
			}
			appendSetupEvent(
				sessionId,
				"予算",
				`${session0.maxIterations} iter · ${Math.round(session0.maxWallClockSec / 60)} 分`,
			);
			appendSetupEvent(
				sessionId,
				"Claude",
				"claude -p --output-format stream-json を起動します",
			);

			store.update(sessionId, {
				status: "running",
				phase: "running",
				startedAt: Date.now(),
				completedAt: null,
				verdictPassed: null,
				verdictReason: null,
				verdictFailingTest: null,
				finalAssistantText: null,
				claudeSessionId: null,
				totalCostUsd: null,
				totalNumTurns: null,
				iteration: 0,
				startHeadSha,
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

			let claudeSessionId: string | null = null;
			let lastAssistantText: string | null = null;
			let aggregatedCostUsd = 0;
			let aggregatedNumTurns = 0;
			let iteration = 0;

			while (iteration < session0.maxIterations) {
				if (ac.signal.aborted) break;
				if (
					Date.now() - run.startedAt >
					session0.maxWallClockSec * 1000
				) {
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
				const pendingIntervention =
					liveSession?.pendingIntervention ?? null;
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
					customSystemPrompt:
						currentSession.customSystemPrompt ?? null,
					signal: ac.signal,
					onChild: (child) => {
						run.currentChild = child;
					},
				});
				run.currentChild = null;

				if (ac.signal.aborted) return;

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

				// No verify → single-turn mode. Claude is done, we are done.
				if (!currentSession.verifyCommand) {
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
				appendVerifyEvent(sessionId, iteration, verdict);

				if (verdict.passed) {
					store.update(sessionId, {
						status: "done",
						phase: "done",
						verdictPassed: true,
						verdictReason:
							lastAssistantText ??
							"verify コマンドが exit 0 で完了しました",
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
			this.active = undefined;
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

			const onAbort = () => {
				try {
					child.kill("SIGINT");
				} catch {
					// ignore
				}
			};
			params.signal.addEventListener("abort", onAbort);

			// Single-shot settlement. `child.on("error", ...)` can fire
			// WITHOUT a subsequent `close` (e.g. ENOENT when the claude
			// binary is missing from PATH), and without this guard the
			// outer promise would hang forever and the session would get
			// stuck in `running`. Both the error and close handlers now
			// funnel through this helper.
			const settle = () => {
				if (settled) return;
				settled = true;
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
					error: errorText,
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
				if (parsed.event) {
					getTodoSessionStore().appendStreamEvents(params.sessionId, [
						{
							id: randomUUID(),
							ts: Date.now(),
							iteration: params.iteration,
							kind: parsed.event.kind,
							label: parsed.event.label,
							text: parsed.event.text,
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
		sections.push(
			`${goalPath} を読み直し、${goalClause}。`,
		);
	}
	if (intervention) {
		sections.push(
			`ユーザーからの介入指示（優先度: 高）:\n${intervention}`,
		);
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
	const stripAnsi = log.replace(/\x1b\[[0-9;]*m/g, "");
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
}

interface ClassifiedLine {
	sessionId: string | null;
	resultText: string | null;
	costUsd: number | null;
	numTurns: number | null;
	event: ClassifiedEvent | null;
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
	};
	if (typeof payload !== "object" || payload === null) return empty;
	const rec = payload as Record<string, unknown>;
	const type = typeof rec.type === "string" ? (rec.type as string) : "";
	const sessionId =
		typeof rec.session_id === "string" ? (rec.session_id as string) : null;

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
		if (text) {
			return {
				...empty,
				sessionId,
				event: { kind: "assistant_text", label: "Claude", text },
			};
		}
		const tool = extractToolUseSummary(rec.message);
		if (tool) {
			return {
				...empty,
				sessionId,
				event: { kind: "tool_use", label: tool.label, text: tool.text },
			};
		}
		return empty;
	}

	if (type === "user") {
		const text = extractToolResultText(rec.message);
		if (text) {
			return {
				...empty,
				sessionId,
				event: {
					kind: "tool_result",
					label: "tool result",
					text: truncate(text, 400),
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
): { label: string; text: string } | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type !== "tool_use") continue;
		const name = typeof rec.name === "string" ? (rec.name as string) : "tool";
		const input = rec.input;
		const inputSummary = summarizeToolInput(name, input);
		return { label: name, text: inputSummary };
	}
	return null;
}

function extractToolResultText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type === "tool_result") {
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
	return joined.length > 0 ? joined : null;
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
			label: iteration === 1 ? "最初のプロンプト" : `イテレーション ${iteration}`,
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
