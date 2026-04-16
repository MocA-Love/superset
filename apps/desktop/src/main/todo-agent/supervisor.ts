import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelectTodoSession } from "@superset/local-db";
import { getTodoDaemonClient } from "main/lib/todo-daemon/client";
import { resolveWorktreePath } from "./session-store";
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

	async start(sessionId: string): Promise<void> {
		try {
			await getTodoDaemonClient().start({ sessionId });
		} catch (error) {
			console.warn("[todo-supervisor] daemon start failed", error);
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
