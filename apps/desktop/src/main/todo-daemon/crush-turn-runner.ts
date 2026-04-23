import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { TodoStreamEventKind } from "main/todo-agent/types";

/**
 * Crush CLI (`crush run`) turn runner.
 *
 * Runs a single Crush iteration via `crush run --yolo` and monitors
 * progress by polling the project-local SQLite database
 * (`<project>/.crush/crush.db`). Crush does not emit structured
 * streaming events on stdout (unlike Claude Code or Codex), but it
 * writes every message — including tool calls, tool results, and
 * finish events — into `crush.db` in real time. We poll this DB and
 * convert new rows into the same `TodoStreamEvent` shape the
 * supervisor engine uses.
 *
 * Session resume is supported via `crush run --session <id>`.
 *
 * See: https://github.com/charmbracelet/crush
 */

export interface CrushTurnParams {
	sessionId: string;
	iteration: number;
	cwd: string;
	prompt: string;
	resumeSessionId: string | null;
	customSystemPrompt: string | null;
	crushModel: string | null;
	signal: AbortSignal;
	onChild: (child: ChildProcess) => void;
	emit: (event: CrushStreamEvent) => void;
}

export interface CrushTurnResult {
	result: string | null;
	sessionId: string | null;
	costUsd: number | null;
	numTurns: number | null;
	error: string | null;
	interrupted: boolean;
}

export interface CrushStreamEvent {
	id: string;
	ts: number;
	iteration: number;
	kind: TodoStreamEventKind;
	label: string;
	text: string;
	toolUseId?: string;
}

const CRUSH_BIN =
	process.env.TODO_CRUSH_BIN || process.env.CRUSH_BIN || "crush";

const POLL_INTERVAL_MS = 250;

// ---- Main entry point ----

export async function runCrushTurn(
	params: CrushTurnParams,
): Promise<CrushTurnResult> {
	const args = buildArgs(params);

	let child: ChildProcess;
	try {
		child = spawn(CRUSH_BIN, args, {
			cwd: params.cwd,
			env: { ...process.env },
			detached: process.platform !== "win32",
		});
	} catch (error) {
		return {
			result: null,
			sessionId: null,
			costUsd: null,
			numTurns: null,
			error:
				error instanceof Error
					? `crush を起動できませんでした: ${error.message}`
					: "crush を起動できませんでした",
			interrupted: false,
		};
	}

	params.onChild(child);

	let crushSessionId: string | null = null;
	let resultText: string | null = null;
	let costUsd: number | null = null;
	let numTurns = 0;
	let errorText: string | null = null;
	let interrupted = false;

	// Extract session id from stderr:
	// "INFO Created session for non-interactive run session_id=..."
	let stderrBuffer = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBuffer += chunk.toString("utf8");
		const match = stderrBuffer.match(
			/session_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
		);
		if (match && !crushSessionId) {
			crushSessionId = match[1];
			params.emit({
				id: randomUUID(),
				ts: Date.now(),
				iteration: params.iteration,
				kind: "system_init",
				label: "Crush",
				text: `Crush セッション開始 (id: ${crushSessionId.slice(0, 8)}...)`,
			});
		}
	});

	// Collect stdout (final result text)
	let stdoutBuffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuffer += chunk.toString("utf8");
	});

	// Start DB polling in parallel with process execution
	const pollPromise = pollDbForEvents(params, () => crushSessionId);

	// Wait for child to exit
	const exitCode = await new Promise<number | null>((resolve) => {
		child.on("close", resolve);
		child.on("error", (err) => {
			errorText = `crush プロセスエラー: ${err.message}`;
			resolve(null);
		});

		if (params.signal.aborted) {
			killProcess(child);
			interrupted = true;
			resolve(null);
			return;
		}
		params.signal.addEventListener(
			"abort",
			() => {
				interrupted = true;
				killProcess(child);
			},
			{ once: true },
		);
	});

	// Give DB polling one final sweep after process exits
	const pollResult = await pollPromise;

	// Collect final result
	resultText = stdoutBuffer.trim() || pollResult.lastAssistantText || null;
	numTurns = pollResult.numTurns;

	// Read cost from DB if available
	if (crushSessionId) {
		const dbPath = findCrushDb(params.cwd);
		if (dbPath) {
			try {
				const db = new Database(dbPath, { readonly: true });
				const row = db
					.prepare("SELECT cost FROM sessions WHERE id = ?")
					.get(crushSessionId) as { cost: number } | undefined;
				if (row) costUsd = row.cost;
				db.close();
			} catch {
				// best-effort
			}
		}
	}

	if (exitCode !== 0 && exitCode !== null && !interrupted) {
		errorText = errorText ?? `crush が終了コード ${exitCode} で終了しました`;
	}

	return {
		result: resultText,
		sessionId: crushSessionId,
		costUsd,
		numTurns: numTurns || null,
		error: errorText,
		interrupted,
	};
}

// ---- Arg builder ----

function buildArgs(params: CrushTurnParams): string[] {
	const args = ["run", "--yolo"];

	if (params.crushModel) {
		args.push("--model", params.crushModel);
	}

	if (params.resumeSessionId) {
		args.push("--session", params.resumeSessionId);
	}

	// Prepend system instructions since Crush `run` has no dedicated flag.
	const promptParts: string[] = [];
	if (params.customSystemPrompt) {
		promptParts.push(
			`[System Instructions]\n${params.customSystemPrompt}\n[End System Instructions]\n\n`,
		);
	}
	promptParts.push(params.prompt);
	args.push(promptParts.join(""));

	return args;
}

// ---- DB polling ----

interface PollResult {
	lastAssistantText: string | null;
	numTurns: number;
}

async function pollDbForEvents(
	params: CrushTurnParams,
	getSessionId: () => string | null,
): Promise<PollResult> {
	let lastSeenCreatedAt = 0;
	let lastAssistantText: string | null = null;
	let numTurns = 0;
	const settled = false;

	while (!settled && !params.signal.aborted) {
		await sleep(POLL_INTERVAL_MS);

		const sessionId = getSessionId();
		if (!sessionId) continue;

		const dbPath = findCrushDb(params.cwd);
		if (!dbPath) continue;

		let db: Database.Database | null = null;
		try {
			db = new Database(dbPath, { readonly: true });
			const rows = db
				.prepare(
					"SELECT id, role, parts, created_at FROM messages WHERE session_id = ? AND created_at > ? ORDER BY created_at ASC",
				)
				.all(sessionId, lastSeenCreatedAt) as Array<{
				id: string;
				role: string;
				parts: string;
				created_at: number;
			}>;

			for (const row of rows) {
				lastSeenCreatedAt = Math.max(lastSeenCreatedAt, row.created_at);
				const parts = safeParseJson(row.parts);
				if (!parts) continue;

				for (const part of parts) {
					const events = classifyPart(part, row.role, params.iteration);
					for (const evt of events) {
						params.emit(evt);
						if (evt.kind === "assistant_text" && evt.text) {
							lastAssistantText = evt.text;
						}
						if (evt.kind === "result") {
							numTurns++;
						}
					}
				}
			}

			// Check if session has finished (finish reason in last assistant message)
			if (rows.length > 0) {
				const lastRow = rows[rows.length - 1];
				const lastParts = safeParseJson(lastRow.parts);
				if (lastParts) {
					for (const p of lastParts) {
						if (
							p.type === "finish" &&
							(p.data?.reason === "end_turn" || p.data?.reason === "stop")
						) {
							// Session completed naturally
						}
					}
				}
			}
		} catch {
			// DB may be locked or not yet created — retry
		} finally {
			db?.close();
		}
	}

	return { lastAssistantText, numTurns };
}

// ---- Event classification ----

function classifyPart(
	part: PartData,
	role: string,
	iteration: number,
): CrushStreamEvent[] {
	const events: CrushStreamEvent[] = [];
	const ts = Date.now();

	if (part.type === "text" && role === "assistant") {
		const text = part.data?.text ?? "";
		if (text.length > 0) {
			events.push({
				id: randomUUID(),
				ts,
				iteration,
				kind: "assistant_text",
				label: "Crush",
				text: truncate(text, 4000),
			});
		}
	} else if (part.type === "tool_call") {
		const name = part.data?.name ?? "unknown";
		const input = part.data?.input ?? "";
		const id = part.data?.id;
		events.push({
			id: randomUUID(),
			ts,
			iteration,
			kind: "tool_use",
			label: toolLabel(name),
			text: truncate(
				typeof input === "string" ? input : JSON.stringify(input),
				2000,
			),
			toolUseId: id,
		});
	} else if (part.type === "tool_result") {
		const content = part.data?.content ?? "";
		const isError = part.data?.is_error ?? false;
		const toolCallId = part.data?.tool_call_id;
		events.push({
			id: randomUUID(),
			ts,
			iteration,
			kind: isError ? "error" : "tool_result",
			label: isError ? "Error" : "Result",
			text: truncate(
				typeof content === "string" ? content : JSON.stringify(content),
				4000,
			),
			toolUseId: toolCallId,
		});
	} else if (part.type === "finish" && role === "assistant") {
		const reason = part.data?.reason ?? "unknown";
		if (
			reason === "error" ||
			reason === "canceled" ||
			reason === "permission_denied"
		) {
			events.push({
				id: randomUUID(),
				ts,
				iteration,
				kind: "error",
				label: "Crush",
				text: `終了理由: ${reason}`,
			});
		} else if (reason === "end_turn" || reason === "stop") {
			events.push({
				id: randomUUID(),
				ts,
				iteration,
				kind: "result",
				label: "Crush",
				text: `ターン完了`,
			});
		}
	}
	// "reasoning" and "binary" parts are intentionally skipped

	return events;
}

function toolLabel(name: string): string {
	const labels: Record<string, string> = {
		bash: "Bash",
		edit: "Edit",
		write: "Write",
		view: "Read",
		glob: "Glob",
		grep: "Grep",
		ls: "LS",
		agent: "Agent",
		fetch: "Fetch",
		sourcegraph: "Sourcegraph",
		multiedit: "MultiEdit",
		todos: "Todos",
	};
	return labels[name] ?? name;
}

// ---- Helpers ----

function killProcess(child: ChildProcess) {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
		} else if (child.pid) {
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {
		child.kill("SIGKILL");
	}
}

function findCrushDb(cwd: string): string | null {
	const dbPath = path.join(cwd, ".crush", "crush.db");
	try {
		fs.accessSync(dbPath);
		return dbPath;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(text: string): PartData[] | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}…`;
}

interface PartData {
	type: string;
	data?: {
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		input?: string;
		tool_call_id?: string;
		content?: string;
		is_error?: boolean;
		reason?: string;
		[key: string]: unknown;
	};
}
