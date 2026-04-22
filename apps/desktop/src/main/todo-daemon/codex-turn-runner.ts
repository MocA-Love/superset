import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	CODEX_EFFORT_OPTIONS,
	CODEX_MODEL_OPTIONS,
	type TodoStreamEventKind,
} from "main/todo-agent/types";
import { getTodoSessionStore } from "main/todo-agent/session-store";

/**
 * Codex CLI (`codex exec`) turn runner.
 *
 * Runs a single Codex iteration via `codex exec --json --full-auto` and
 * parses the NDJSON event stream emitted on stdout. Structured events are
 * classified into the same `TodoStreamEvent` shape the Claude Code runner
 * uses so the supervisor engine and UI can remain agent-agnostic.
 *
 * Session resume is supported via `codex exec resume <thread_id>`.
 *
 * See: https://developers.openai.com/codex/noninteractive
 * Source: github.com/openai/codex/codex-rs/exec/src/exec_events.rs
 */

export interface CodexTurnParams {
	sessionId: string;
	iteration: number;
	cwd: string;
	prompt: string;
	resumeThreadId: string | null;
	customSystemPrompt: string | null;
	codexModel: string | null;
	codexEffort: string | null;
	signal: AbortSignal;
	onChild: (child: ChildProcess) => void;
}

export interface CodexTurnResult {
	result: string | null;
	threadId: string | null;
	costUsd: number | null;
	numTurns: number | null;
	error: string | null;
	interrupted: boolean;
}

const CODEX_BIN =
	process.env.TODO_CODEX_BIN || process.env.CODEX_BIN || "codex";

export async function runCodexTurn(
	params: CodexTurnParams,
): Promise<CodexTurnResult> {
	const args = buildArgs(params);

	let child: ChildProcess;
	try {
		child = spawn(CODEX_BIN, args, {
			cwd: params.cwd,
			env: {
				...process.env,
				// Ensure Codex uses the workspace cwd.
			},
			detached: process.platform !== "win32",
		});
	} catch (error) {
		return {
			result: null,
			threadId: null,
			costUsd: null,
			numTurns: null,
			error:
				error instanceof Error
					? `codex を起動できませんでした: ${error.message}`
					: "codex を起動できませんでした",
			interrupted: false,
		};
	}

	params.onChild(child);

	let threadId: string | null = null;
	let resultText: string | null = null;
	let numTurns: number | null = null;
	let errorText: string | null = null;
	let stdoutBuffer = "";
	let stderrBuffer = "";
	let settled = false;
	let interruptedForIntervention = false;

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

	return new Promise<CodexTurnResult>((resolve) => {
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
				threadId,
				costUsd: null,
				numTurns,
				error: interruptedForIntervention ? null : errorText,
				interrupted: interruptedForIntervention,
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
			const parsed = classifyCodexEvent(payload);
			if (parsed.threadId && !threadId) {
				threadId = parsed.threadId;
			}
			if (parsed.resultText) {
				resultText = parsed.resultText;
			}
			if (parsed.numTurns != null) {
				numTurns = parsed.numTurns;
			}
			for (const evt of parsed.events) {
				getTodoSessionStore().appendStreamEvents(params.sessionId, [
					{
						id: randomUUID(),
						ts: Date.now(),
						iteration: params.iteration,
						kind: evt.kind,
						label: evt.label,
						text: evt.text,
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
				errorText = `codex プロセスエラー: ${err.message}`;
			}
			settle();
		});
		child.on("close", (code) => {
			if (code !== 0 && !resultText && !errorText) {
				const tail = stderrBuffer.trim().split("\n").slice(-6).join("\n");
				errorText = `codex が exit code ${code} で終了しました${
					tail ? `:\n${tail}` : ""
				}`;
			}
			settle();
		});
	});
}

// ---- Arg builder ----

function buildArgs(params: CodexTurnParams): string[] {
	const args: string[] = [];

	if (params.resumeThreadId) {
		args.push("exec", "resume", params.resumeThreadId);
	} else {
		args.push("exec");
	}

	args.push("--json");
	args.push("--full-auto");
	args.push("--sandbox", "workspace-write");

	if (params.customSystemPrompt) {
		args.push("--developer-instructions", params.customSystemPrompt);
	}

	if (
		params.codexModel &&
		(CODEX_MODEL_OPTIONS as readonly string[]).includes(params.codexModel)
	) {
		args.push("--model", params.codexModel);
	} else if (params.codexModel) {
		console.warn(
			"[todo-daemon:codex] ignoring unknown codexModel:",
			params.codexModel,
		);
	}

	if (
		params.codexEffort &&
		(CODEX_EFFORT_OPTIONS as readonly string[]).includes(params.codexEffort)
	) {
		args.push(
			"--config",
			`model_reasoning_effort=${params.codexEffort}`,
		);
	} else if (params.codexEffort) {
		console.warn(
			"[todo-daemon:codex] ignoring unknown codexEffort:",
			params.codexEffort,
		);
	}

	if (!params.resumeThreadId) {
		args.push(params.prompt);
	}

	return args;
}

// ---- Codex event classifier ----

interface ClassifiedEvent {
	kind: TodoStreamEventKind;
	label: string;
	text: string;
}

interface ClassifiedCodexLine {
	threadId: string | null;
	resultText: string | null;
	numTurns: number | null;
	events: ClassifiedEvent[];
}

function classifyCodexEvent(payload: unknown): ClassifiedCodexLine {
	const empty: ClassifiedCodexLine = {
		threadId: null,
		resultText: null,
		numTurns: null,
		events: [],
	};
	if (typeof payload !== "object" || payload === null) return empty;
	const rec = payload as Record<string, unknown>;
	const type = typeof rec.type === "string" ? (rec.type as string) : "";

	if (type === "thread.started") {
		const threadId =
			typeof rec.thread_id === "string"
				? (rec.thread_id as string)
				: null;
		return {
			...empty,
			threadId,
			events: [
				{
					kind: "system_init",
					label: "init",
					text: `thread ${threadId ?? "?"} 準備完了`,
				},
			],
		};
	}

	if (type === "turn.started") {
		return empty;
	}

	if (type === "turn.completed") {
		const usage = rec.usage as
			| { input_tokens?: number; output_tokens?: number }
			| undefined;
		const tokens = usage
			? `${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`
			: "";
		return {
			...empty,
			numTurns: 1,
			events: [
				{
					kind: "result",
					label: "turn completed",
					text: tokens ? `ターン完了 (${tokens})` : "ターン完了",
				},
			],
		};
	}

	if (type === "turn.failed") {
		const error = rec.error as { message?: string } | undefined;
		const msg = error?.message ?? "不明なエラー";
		return {
			...empty,
			events: [{ kind: "error", label: "error", text: msg }],
		};
	}

	if (
		type === "item.started" ||
		type === "item.updated" ||
		type === "item.completed"
	) {
		const item = rec.item as Record<string, unknown> | undefined;
		if (!item) return empty;
		return classifyItem(item, type);
	}

	if (type === "error") {
		const message =
			typeof rec.message === "string"
				? (rec.message as string)
				: JSON.stringify(rec).slice(0, 400);
		return {
			...empty,
			events: [{ kind: "error", label: "error", text: message }],
		};
	}

	return empty;
}

function classifyItem(
	item: Record<string, unknown>,
	eventType: string,
): ClassifiedCodexLine {
	const empty: ClassifiedCodexLine = {
		threadId: null,
		resultText: null,
		numTurns: null,
		events: [],
	};
	const itemType =
		typeof item.type === "string" ? (item.type as string) : "";

	if (itemType === "agent_message") {
		const text = typeof item.text === "string" ? (item.text as string) : null;
		if (!text) return empty;
		return {
			...empty,
			resultText: eventType === "item.completed" ? text : null,
			events: [
				{
					kind: eventType === "item.completed" ? "assistant_text" : "assistant_text",
					label: "Codex",
					text,
				},
			],
		};
	}

	if (
		itemType === "command_execution" ||
		itemType === "file_edit" ||
		itemType === "code_edit"
	) {
		const command =
			typeof item.command === "string"
				? (item.command as string)
				: typeof item.path === "string"
					? (item.path as string)
					: itemType;
		const label =
			itemType === "command_execution"
				? "Bash"
				: itemType === "file_edit"
					? "Edit"
					: "tool";
		return {
			...empty,
			events: [
				{
					kind: "tool_use",
					label,
					text: truncate(command, 300),
				},
			],
		};
	}

	if (itemType === "tool_result" || itemType === "command_output") {
		const text =
			typeof item.text === "string"
				? (item.text as string)
				: typeof item.output === "string"
					? (item.output as string)
					: null;
		if (!text) return empty;
		return {
			...empty,
			events: [
				{
					kind: "tool_result",
					label: "tool result",
					text: truncate(text, 400),
				},
			],
		};
	}

	return empty;
}

// ---- Helpers ----

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			const killer = spawn(
				"taskkill",
				["/pid", String(pid), "/T", "/F"],
				{ stdio: "ignore", detached: true },
			);
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

function truncate(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}…`;
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
