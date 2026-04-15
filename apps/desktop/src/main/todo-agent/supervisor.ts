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
				const idled = await this.waitForIdle(
					promptSession.attachedPaneId as string,
					DEFAULT_IDLE_WINDOW_MS,
					session0.maxWallClockSec * 1000,
					ac.signal,
				);
				if (!idled) break;

				store.update(sessionId, { phase: "verifying" });
				const verdict = await runVerify(
					promptSession.verifyCommand,
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
	): Promise<boolean> {
		return new Promise((resolve) => {
			const terminal = getWorkspaceRuntimeRegistry().getDefault().terminal;
			let idleTimer: NodeJS.Timeout | undefined;
			let hardTimer: NodeJS.Timeout | undefined;
			const start = Date.now();

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
					resolve(true);
				}, idleWindowMs);
			};

			const onData = () => kickIdle();
			const onAbort = () => {
				cleanup();
				resolve(false);
			};

			terminal.on(`data:${paneId}`, onData);
			signal.addEventListener("abort", onAbort);
			hardTimer = setTimeout(() => {
				cleanup();
				resolve(true);
			}, hardCapMs);
			kickIdle();
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
	return [
		`# TODO: ${session.title}`,
		"",
		"## Description",
		session.description,
		"",
		"## Goal (acceptance criteria)",
		session.goal,
		"",
		"## Verify command",
		"```sh",
		session.verifyCommand,
		"```",
		"",
		`Budget: ${session.maxIterations} iterations, ${session.maxWallClockSec}s wall clock.`,
		"",
	].join("\n");
}

function buildIterationPrompt(
	session: SelectTodoSession,
	iteration: number,
): string {
	const header =
		iteration === 1
			? `You are executing an autonomous TODO task. Goal file is at .superset/todo/${session.id}/goal.md. Read it, then work towards the goal. When you believe a turn is complete, stop and wait; an external verifier will run \`${session.verifyCommand}\` and tell you if you need another turn.`
			: `Iteration ${iteration}. The verify command \`${session.verifyCommand}\` failed. Reason: ${session.verdictReason ?? "unknown"}. Continue working toward the goal in .superset/todo/${session.id}/goal.md.`;
	return header;
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

function guessFailingTest(log: string): string | undefined {
	// Very rough heuristic: first line that looks like a test failure marker.
	const match = log.match(/(?:FAIL|✗|×)\s+([^\s][^\n]+)/);
	return match?.[1]?.trim();
}
