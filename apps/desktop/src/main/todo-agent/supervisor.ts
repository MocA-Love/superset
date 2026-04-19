import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelectTodoSession } from "@superset/local-db";
import { getTodoDaemonClient } from "main/lib/todo-daemon/client";
import { getTodoSessionDebugData, todoAgentMainDebug } from "./debug";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
import { TODO_ARTIFACT_SUBDIR } from "./types";

/**
 * Main-process façade for the TODO supervisor.
 *
 * The heavy lifting (spawning `claude -p`, driving the iteration loop,
 * parsing stream-json, updating `todo_sessions`) lives in the
 * `todo-daemon` process so in-flight sessions survive app restarts —
 * see issue #237. This class proxies each public method to the daemon
 * over the daemon-client socket. Pure-filesystem helpers
 * (`computeArtifactPath`, `prepareArtifacts`) stay in the main process
 * because tRPC calls them before the session ever leaves the UI path.
 */
class TodoSupervisor {
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

	prepareArtifacts(session: SelectTodoSession): string {
		const dir = session.artifactPath;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "goal.md"), renderGoalDoc(session), "utf8");
		return dir;
	}

	async start(
		sessionId: string,
		options?: { fromScheduledWakeup?: boolean },
	): Promise<void> {
		const current = getTodoSessionStore().get(sessionId);
		todoAgentMainDebug.info(
			"todo-supervisor-start",
			{
				sessionId,
				fromScheduledWakeup: options?.fromScheduledWakeup ?? false,
				...(current ? getTodoSessionDebugData(current) : {}),
			},
			{
				captureMessage: true,
				fingerprint: ["todo.agent.main", "todo-supervisor-start"],
			},
		);
		try {
			await getTodoDaemonClient().start({
				sessionId,
				fromScheduledWakeup: options?.fromScheduledWakeup,
			});
			todoAgentMainDebug.info(
				"todo-supervisor-start-success",
				{
					sessionId,
					fromScheduledWakeup: options?.fromScheduledWakeup ?? false,
				},
				{
					captureMessage: true,
					fingerprint: ["todo.agent.main", "todo-supervisor-start-success"],
				},
			);
		} catch (error) {
			// The tRPC router flips the session to `preparing` before
			// fire-and-forgetting us, so a daemon spawn/connect/auth
			// failure here would otherwise leave the row stuck in
			// `preparing` with no way for the UI to recover. Persist a
			// terminal failure state so the user sees the problem and
			// can retry or delete the session.
			const reason = error instanceof Error ? error.message : String(error);
			console.warn("[todo-supervisor] daemon start failed", error);
			todoAgentMainDebug.captureException(
				error,
				"todo-supervisor-start-failed",
				{
					sessionId,
					fromScheduledWakeup: options?.fromScheduledWakeup ?? false,
					errorMessage: reason,
				},
				{
					fingerprint: ["todo.agent.main", "todo-supervisor-start-failed"],
				},
			);
			try {
				const store = getTodoSessionStore();
				const current = store.get(sessionId);
				if (
					current &&
					(current.status === "preparing" ||
						current.status === "queued" ||
						current.status === "waiting")
				) {
					store.update(sessionId, {
						status: "failed",
						phase: "failed",
						verdictPassed: false,
						verdictReason: `todo-daemon を起動できませんでした: ${reason}`,
						completedAt: Date.now(),
					});
				}
			} catch (persistError) {
				console.warn(
					"[todo-supervisor] failed to persist daemon failure state",
					persistError,
				);
			}
			throw error;
		}
	}

	abort(sessionId: string): void {
		void getTodoDaemonClient()
			.abort({ sessionId })
			.catch((error) => {
				console.warn("[todo-supervisor] daemon abort failed", error);
			});
	}

	queueIntervention(sessionId: string, data: string): void {
		void getTodoDaemonClient()
			.queueIntervention({ sessionId, data })
			.catch((error) => {
				console.warn(
					"[todo-supervisor] daemon queueIntervention failed",
					error,
				);
			});
	}

	handleSettingsChanged(): void {
		void getTodoDaemonClient()
			.settingsChanged()
			.catch((error) => {
				console.warn("[todo-supervisor] daemon settingsChanged failed", error);
			});
	}
}

let supervisor: TodoSupervisor | undefined;
export function getTodoSupervisor(): TodoSupervisor {
	if (!supervisor) supervisor = new TodoSupervisor();
	return supervisor;
}

function renderGoalDoc(session: SelectTodoSession): string {
	const lines: string[] = [
		session.title ? `# TODO: ${session.title}` : "# TODO",
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
