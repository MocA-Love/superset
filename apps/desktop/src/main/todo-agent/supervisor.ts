import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelectTodoSession } from "@superset/local-db";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import {
	DEFAULT_IDLE_WINDOW_MS,
	MIN_IDLE_BEFORE_VERIFY_MS,
	TODO_ARTIFACT_SUBDIR,
} from "./types";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";

interface ActiveRun {
	sessionId: string;
	abortController: AbortController;
	lastFailingTest?: string;
	consecutiveSameFailure: number;
	lastDiffHash?: string;
	consecutiveSameDiff: number;
	startedAt: number;
}

/**
 * Singleton TODO Supervisor.
 *
 * Responsibilities
 * - Accept a session and drive it to a terminal verdict (done/failed/escalated/aborted).
 * - Compose per-iteration prompts and write them to the worker's PTY via
 *   the workspace terminal runtime.
 * - Detect turn completion via PTY idle timing.
 * - Run the user-defined verify command after each turn.
 * - Apply budget + futility guards.
 *
 * The supervisor does NOT create the terminal pane itself; the renderer
 * creates it and passes the paneId via `todo.attachPane`. This is because
 * panes are a client-side (Zustand) concept in this codebase.
 */
class TodoSupervisor {
	private active: ActiveRun | undefined;
	private readonly queue: string[] = [];

	/**
	 * Ensure the session's artifact directory exists and `goal.md` is
	 * written. Called at session creation.
	 */
	prepareArtifacts(session: SelectTodoSession): string {
		const worktreePath = resolveWorktreePath(session.workspaceId);
		if (!worktreePath) {
			throw new Error(
				`todo-agent: no worktree path for workspace ${session.workspaceId}`,
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

	/**
	 * Called by trpc `todo.attachPane` after the renderer has created a
	 * terminal pane, launched an interactive `claude` inside it, and is
	 * ready for the supervisor to take over the input side.
	 */
	async attachAndStart(sessionId: string): Promise<void> {
		if (this.active) {
			// Already running something else; queue it.
			if (!this.queue.includes(sessionId)) this.queue.push(sessionId);
			return;
		}
		await this.runSession(sessionId);
		// After the run settles, drain the queue.
		while (this.queue.length > 0) {
			const next = this.queue.shift();
			if (next) await this.runSession(next);
		}
	}

	abort(sessionId: string): void {
		if (this.active?.sessionId === sessionId) {
			this.active.abortController.abort();
		}
		const store = getTodoSessionStore();
		const session = store.get(sessionId);
		if (!session) return;
		// Try to interrupt the running claude in the pane.
		if (session.attachedPaneId) {
			this.writeToPane(session.attachedPaneId, "\x03\x03");
		}
		store.update(sessionId, {
			status: "aborted",
			completedAt: Date.now(),
		});
	}

	sendInput(sessionId: string, data: string): void {
		const store = getTodoSessionStore();
		const session = store.get(sessionId);
		if (!session?.attachedPaneId) return;
		this.writeToPane(session.attachedPaneId, data);
	}

	// ---- internals ----

	private async runSession(sessionId: string): Promise<void> {
		const store = getTodoSessionStore();
		const session0 = store.get(sessionId);
		if (!session0) return;
		if (!session0.attachedPaneId) {
			store.update(sessionId, {
				status: "failed",
				verdictReason: "No pane attached to session",
				completedAt: Date.now(),
			});
			return;
		}

		const ac = new AbortController();
		const run: ActiveRun = {
			sessionId,
			abortController: ac,
			consecutiveSameFailure: 0,
			consecutiveSameDiff: 0,
			startedAt: Date.now(),
		};
		this.active = run;

		try {
			store.update(sessionId, {
				status: "running",
				startedAt: Date.now(),
			});

			// Single-turn mode: no verify command means "research /
			// investigation / one-shot". Write the initial prompt, wait for
			// the worker to go idle, then settle. Before marking done we
			// scan the captured PTY output for startup errors (auth,
			// command-not-found, crash) so we do not report "done" on a
			// worker that never actually ran.
			if (!session0.verifyCommand) {
				store.update(sessionId, { iteration: 1, phase: "running" });
				const promptSession = store.get(sessionId);
				if (!promptSession) return;
				const prompt = buildIterationPrompt(promptSession, 1);
				this.writeToPane(
					promptSession.attachedPaneId as string,
					`${prompt}\n`,
				);
				const { idled, buffer } = await this.waitForIdle(
					promptSession.attachedPaneId as string,
					DEFAULT_IDLE_WINDOW_MS,
					session0.maxWallClockSec * 1000,
					ac.signal,
				);
				if (ac.signal.aborted) return;
				const startupError = detectStartupError(buffer);
				if (startupError) {
					store.update(sessionId, {
						status: "failed",
						phase: "failed",
						verdictPassed: false,
						verdictReason: startupError,
						completedAt: Date.now(),
					});
					return;
				}
				store.update(sessionId, {
					status: "done",
					phase: "done",
					verdictPassed: true,
					verdictReason: idled
						? "単発タスク完了。ワーカーの出力をターミナルで確認してください。"
						: "中断されました。",
					completedAt: Date.now(),
				});
				return;
			}

			let iteration = session0.iteration;
			while (iteration < session0.maxIterations) {
				if (ac.signal.aborted) break;
				if (
					Date.now() - run.startedAt >
					session0.maxWallClockSec * 1000
				) {
					store.update(sessionId, {
						status: "escalated",
						verdictReason: "wall-clock budget exhausted",
						completedAt: Date.now(),
					});
					return;
				}

				iteration += 1;
				store.update(sessionId, { iteration, phase: "running" });

				const promptSession = store.get(sessionId);
				if (!promptSession) return;
				const prompt = buildIterationPrompt(promptSession, iteration);
				this.writeToPane(
					promptSession.attachedPaneId as string,
					`${prompt}\n`,
				);

				// Wait for the PTY to go idle, indicating the turn is done.
				const { idled, buffer } = await this.waitForIdle(
					promptSession.attachedPaneId as string,
					DEFAULT_IDLE_WINDOW_MS,
					session0.maxWallClockSec * 1000,
					ac.signal,
				);
				if (!idled) break;

				// On the first iteration, short-circuit if the worker never
				// actually started (auth / not-found / crash). Running the
				// verify command against a broken worker would produce a
				// misleading "failed verify" instead of the real reason.
				if (iteration === 1) {
					const startupError = detectStartupError(buffer);
					if (startupError) {
						store.update(sessionId, {
							status: "failed",
							phase: "failed",
							verdictPassed: false,
							verdictReason: startupError,
							completedAt: Date.now(),
						});
						return;
					}
				}

				store.update(sessionId, { phase: "verifying" });
				const verdict = await runVerify(
					// biome-ignore lint/style/noNonNullAssertion: verifyCommand is non-null in this branch (checked above)
					promptSession.verifyCommand!,
					promptSession.workspaceId,
					ac.signal,
				);

				if (verdict.passed) {
					store.update(sessionId, {
						status: "done",
						phase: "done",
						verdictPassed: true,
						verdictReason: "verify command exited 0",
						completedAt: Date.now(),
					});
					return;
				}

				// Futility: same failing test 3x in a row.
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
						verdictPassed: false,
						verdictReason: `futility: ${verdict.failingTest ?? "same failure"} recurred ${run.consecutiveSameFailure} times`,
						verdictFailingTest: verdict.failingTest,
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

			store.update(sessionId, {
				status: "escalated",
				verdictReason: "iteration budget exhausted",
				completedAt: Date.now(),
			});
		} finally {
			this.active = undefined;
		}
	}

	private writeToPane(paneId: string, data: string): void {
		const terminal = getWorkspaceRuntimeRegistry().getDefault().terminal;
		try {
			terminal.write({ paneId, data });
		} catch (error) {
			console.error("[todo-agent] write failed", error);
		}
	}

	private waitForIdle(
		paneId: string,
		idleWindowMs: number,
		hardCapMs: number,
		signal: AbortSignal,
	): Promise<{ idled: boolean; buffer: string }> {
		return new Promise((resolve) => {
			const terminal = getWorkspaceRuntimeRegistry().getDefault().terminal;
			let idleTimer: NodeJS.Timeout | undefined;
			let hardTimer: NodeJS.Timeout | undefined;
			const start = Date.now();
			// Ring-ish buffer: keep the last ~16 KB of PTY output so we can
			// scan it for startup errors (auth failure, command not found,
			// crash banners) after the worker goes idle. 16 KB is enough to
			// hold a typical claude-code TUI header plus any error tail.
			const CAP = 16 * 1024;
			let buffer = "";

			const cleanup = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (hardTimer) clearTimeout(hardTimer);
				terminal.off(`data:${paneId}`, onData);
				signal.removeEventListener("abort", onAbort);
			};

			const kickIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					if (Date.now() - start < MIN_IDLE_BEFORE_VERIFY_MS) {
						kickIdle();
						return;
					}
					cleanup();
					resolve({ idled: true, buffer });
				}, idleWindowMs);
			};

			const onData = (chunk: unknown) => {
				const text =
					typeof chunk === "string"
						? chunk
						: chunk instanceof Uint8Array
							? Buffer.from(chunk).toString("utf8")
							: String(chunk ?? "");
				buffer += text;
				if (buffer.length > CAP) buffer = buffer.slice(-CAP);
				kickIdle();
			};
			const onAbort = () => {
				cleanup();
				resolve({ idled: false, buffer });
			};

			terminal.on(`data:${paneId}`, onData);
			signal.addEventListener("abort", onAbort);
			hardTimer = setTimeout(() => {
				cleanup();
				resolve({ idled: true, buffer });
			}, hardCapMs);
			kickIdle();
		});
	}
}

/**
 * Detect "the worker never really started" conditions by scanning the PTY
 * capture for known fatal markers. Returns a user-facing reason when one is
 * found. Intentionally conservative — we do not want to mistake a normal
 * test failure in the worker's TUI for a startup error.
 */
function detectStartupError(buffer: string): string | undefined {
	// Strip ANSI so pattern matching stays simple.
	const clean = buffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
	const patterns: Array<[RegExp, string]> = [
		[
			/Please run \/login/i,
			"Claude Code の認証が切れています。ワーカーのターミナルで `/login` を実行してください。",
		],
		[
			/authentication_error|Invalid authentication credentials/i,
			"Claude Code の認証に失敗しました（API Error 401）。ワーカーのターミナルで `/login` を実行してください。",
		],
		[
			/claude: command not found|command not found: claude/i,
			"`claude` コマンドが見つかりません。Claude Code CLI がインストールされているか、PATH を確認してください。",
		],
		[
			/API Error:\s*5\d\d/i,
			"Claude Code が API エラー（5xx）を返しました。ネットワークまたは上流サービスの状態を確認してください。",
		],
		[
			/fatal:/i,
			"ワーカーが起動時に fatal エラーを出しました。詳細はワーカーのターミナルを確認してください。",
		],
	];
	for (const [re, reason] of patterns) {
		if (re.test(clean)) return reason;
	}
	return undefined;
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
		"## 説明",
		session.description,
		"",
		"## ゴール（受け入れ条件）",
		session.goal,
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

function buildIterationPrompt(
	session: SelectTodoSession,
	iteration: number,
): string {
	const goalPath = `.superset/todo/${session.id}/goal.md`;
	if (!session.verifyCommand) {
		return `自律 TODO タスクを実行します。まず ${goalPath} を読み、ゴールに向かって作業してください。外部 verify は行いません。ゴールを達成したら停止してください。`;
	}
	if (iteration === 1) {
		return `自律 TODO タスクを実行します。まず ${goalPath} を読み、ゴールに向かって作業してください。ターンが完了したと判断したら停止して待機してください。外部 verifier が \`${session.verifyCommand}\` を実行し、追加のターンが必要かどうかを知らせます。`;
	}
	return `イテレーション ${iteration}。verify コマンド \`${session.verifyCommand}\` が失敗しました。理由: ${session.verdictReason ?? "不明"}。${goalPath} のゴールに向けて作業を続けてください。`;
}

function tailForReason(log: string): string {
	const tail = log.trim().split("\n").slice(-20).join("\n");
	return tail.length > 2000 ? `${tail.slice(-2000)}` : tail;
}

interface VerifyResult {
	passed: boolean;
	log: string;
	failingTest?: string;
}

function runVerify(
	verifyCommand: string,
	workspaceId: string,
	signal: AbortSignal,
): Promise<VerifyResult> {
	return new Promise((resolve) => {
		const cwd = resolveWorktreePath(workspaceId);
		if (!cwd) {
			resolve({ passed: false, log: "no worktree path for workspace" });
			return;
		}
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

/**
 * Extract a stable identifier for the first failing test in a log. Used by
 * the futility detector to decide "same failure recurring" vs "different
 * failure each iteration". The goal is not to pretty-print; it is to return
 * a stable-ish string that stays identical across runs of the same failing
 * test, so we should normalize away run-specific noise (timings, object
 * hex ids, absolute paths of runner binaries).
 *
 * Supported runners, in priority order:
 *   - bun test         `(fail) path/file.test.ts > describe > it`
 *   - vitest           `❯ path/file.test.ts > suite > case` / `FAIL  path`
 *   - jest             `✕ describe > it (12 ms)` / `FAIL  src/…`
 *   - node:test        `not ok 1 - describe > it`
 *   - playwright       `1) [chromium] › path/file:line:col › title`
 *   - plain shell      falls back to first non-empty stderr-looking line.
 */
function guessFailingTest(log: string): string | undefined {
	const stripAnsi = log.replace(/\x1b\[[0-9;]*m/g, "");
	const lines = stripAnsi.split("\n");

	const patterns: RegExp[] = [
		/^\s*\(fail\)\s+(.+?)(?:\s+\[\d.*)?$/i, // bun test
		/^\s*❯\s+(.+?)(?:\s+\d+ms)?$/, // vitest tree view
		/^\s*FAIL\s+(.+?)(?:\s+>\s+.+)?$/, // vitest/jest summary
		/^\s*✕\s+(.+?)(?:\s+\(\d+\s*ms\))?$/, // jest inline fail
		/^\s*×\s+(.+?)(?:\s+\(\d+\s*ms\))?$/, // vitest inline fail
		/^\s*✗\s+(.+?)(?:\s+\(\d+\s*ms\))?$/, // generic
		/^\s*not ok \d+\s*-\s*(.+)$/, // TAP / node:test
		/^\s*\d+\)\s+(?:\[[^\]]+\]\s+)?[›»>]\s+(.+)$/, // playwright
	];

	for (const line of lines) {
		for (const re of patterns) {
			const m = line.match(re);
			if (m?.[1]) {
				return normalizeTestId(m[1]);
			}
		}
	}

	// Fallback: look for "Error:" or "AssertionError:" anchored lines.
	const errorLine = lines.find((l) => /\b(Error|Assertion)\b.*:/.test(l));
	if (errorLine) return normalizeTestId(errorLine.trim());

	return undefined;
}

function normalizeTestId(raw: string): string {
	return raw
		.trim()
		// Drop "(123 ms)" timing suffixes that change every run.
		.replace(/\s*\(\d+\s*ms\)\s*$/, "")
		// Drop "[123.45ms]" suffixes.
		.replace(/\s*\[\d+(?:\.\d+)?\s*m?s\]\s*$/, "")
		// Collapse object hex ids like Foo@0x7f8b3c004a00 → Foo@0x?
		.replace(/@0x[0-9a-f]+/gi, "@0x?")
		// Strip trailing ANSI colon+reason ("...: expected 1 to be 2") which
		// can vary in wording across runs for the same logical failure.
		.replace(/:\s*expected.*$/i, "")
		.slice(0, 240);
}
