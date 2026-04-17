import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTodoSessionStore } from "main/todo-agent/session-store";
import {
	CLAUDE_EFFORT_OPTIONS,
	CLAUDE_MODEL_OPTIONS,
	type TodoStreamEvent,
	type TodoStreamEventKind,
} from "main/todo-agent/types";
import type { IPty } from "node-pty";
import * as pty from "node-pty";

/**
 * PTY-mode Claude Code turn runner.
 *
 * Runs a single Claude Code iteration as an interactive TUI behind a
 * PTY (instead of the default `claude -p` headless stream-json path).
 * Structured events are pulled from the session JSONL transcript at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; turn-end is
 * detected via a Stop hook injected through `--settings`. See
 * `apps/desktop/plans/20260417-todo-agent-remote-control.md`.
 *
 * Enabled only when the daemon process starts with `TODO_ENGINE=pty`
 * **and** the session row has `remote_control_enabled` set. The
 * supervisor engine routes to this runner instead of the headless
 * implementation in `supervisor-engine.ts` under that condition.
 */

// Public shape must match `runClaudeTurn` in supervisor-engine.ts so
// callers can swap implementations transparently.
export interface PtyTurnParams {
	sessionId: string;
	iteration: number;
	cwd: string;
	prompt: string;
	resumeSessionId: string | null;
	customSystemPrompt: string | null;
	claudeModel: string | null;
	claudeEffort: string | null;
	signal: AbortSignal;
	onChild: (handle: { pid: number | null; kill: () => void }) => void;
	/** Whether to send `/remote-control` after the PTY is ready. */
	remoteControlEnabled: boolean;
}

export interface PtyTurnResult {
	result: string | null;
	sessionId: string | null;
	costUsd: number | null;
	numTurns: number | null;
	error: string | null;
	interrupted: boolean;
	scheduledWakeup: { delayMs: number; reason: string | null } | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Path of the POSIX executable whose session JSONL we tail. Falls
 * back to `claude` on PATH when unset (tests / dev shells). */
const CLAUDE_BIN =
	process.env.TODO_CLAUDE_BIN || process.env.CLAUDE_BIN || "claude";

/** Project transcript root used by Claude Code. */
const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** How long we wait after spawn for the JSONL file to appear. */
const JSONL_DISCOVERY_TIMEOUT_MS = 15_000;

/** How often we poll the JSONL file for appended lines. */
const JSONL_POLL_INTERVAL_MS = 250;

/** Max wait for TUI to settle before we send the first prompt. */
const TUI_READY_MAX_WAIT_MS = 25_000;

/** Idle window after which we consider the TUI ready (no stdout). */
const TUI_READY_IDLE_MS = 2_000;

/** Max wait for the Stop hook to fire after a prompt is sent. */
const STOP_HOOK_MAX_WAIT_MS = 30 * 60 * 1000; // 30 min

/** Max wait after sending `/remote-control` for a session URL to
 * appear in PTY stdout. */
const REMOTE_CONTROL_URL_TIMEOUT_MS = 15_000;

const REMOTE_CONTROL_URL_RE =
	/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;

const ATTACHMENT_PATH_RE =
	/!\[[^\]]*\]\(([^()\s]*[/\\]todo-agent[/\\]attachments[/\\][^)\s]+)\)/g;

// =============================================================================
// Public entry point
// =============================================================================

export async function runClaudeTurnPty(
	params: PtyTurnParams,
): Promise<PtyTurnResult> {
	const encodedCwd = encodeCwdForClaude(params.cwd);
	const projectDir = path.join(CLAUDE_PROJECTS_ROOT, encodedCwd);
	ensureDir(projectDir);

	const existingJsonl = new Set(listJsonl(projectDir));

	// Set up the Stop-hook sink before spawning so we never miss events.
	const hookSink = createHookSink(params.sessionId);
	const settings = buildSettingsJson(hookSink.scriptPath);

	const args = [
		"--permission-mode",
		"bypassPermissions",
		"--settings",
		settings,
	];
	if (params.customSystemPrompt) {
		args.push("--append-system-prompt", params.customSystemPrompt);
	}
	if (
		params.claudeModel &&
		(CLAUDE_MODEL_OPTIONS as readonly string[]).includes(params.claudeModel)
	) {
		args.push("--model", params.claudeModel);
	} else if (params.claudeModel) {
		console.warn(
			"[todo-daemon:pty] ignoring unknown claudeModel:",
			params.claudeModel,
		);
	}
	if (
		params.claudeEffort &&
		(CLAUDE_EFFORT_OPTIONS as readonly string[]).includes(params.claudeEffort)
	) {
		args.push("--effort", params.claudeEffort);
	} else if (params.claudeEffort) {
		console.warn(
			"[todo-daemon:pty] ignoring unknown claudeEffort:",
			params.claudeEffort,
		);
	}
	if (params.resumeSessionId) {
		args.push("--resume", params.resumeSessionId);
	}

	let ptyProcess: IPty;
	try {
		ptyProcess = pty.spawn(CLAUDE_BIN, args, {
			name: "xterm-256color",
			cols: 120,
			rows: 40,
			cwd: params.cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
			},
		});
	} catch (error) {
		hookSink.cleanup();
		return {
			result: null,
			sessionId: null,
			costUsd: null,
			numTurns: null,
			error:
				error instanceof Error
					? `claude を PTY 起動できませんでした: ${error.message}`
					: "claude を PTY 起動できませんでした",
			interrupted: false,
			scheduledWakeup: null,
		};
	}

	const state: TurnState = {
		claudeSessionId: params.resumeSessionId,
		lastAssistantText: null,
		costUsd: null,
		numTurns: 0,
		scheduledWakeup: null,
		processedEventCount: 0,
		jsonlPath: null,
		jsonlReadOffset: 0,
		remoteControlUrl: null,
	};

	let ptyBuffer = "";
	// Mutable flags wrapped in an object so TypeScript's control-flow
	// analysis doesn't narrow the closure-captured locals to `never`
	// when we read them later in the same function (the assignments
	// live inside `onExit`/`onData` callbacks and are opaque to the
	// analyzer).
	const ptyStatus: {
		alive: boolean;
		exit: { exitCode: number; signal?: number } | null;
	} = { alive: true, exit: null };
	ptyProcess.onData((data) => {
		ptyBuffer += data;
		// Keep the buffer bounded. We only parse the last page when we
		// need it (ready detection, `/remote-control` URL capture).
		if (ptyBuffer.length > 64 * 1024) {
			ptyBuffer = ptyBuffer.slice(-32 * 1024);
		}
	});
	ptyProcess.onExit((ev) => {
		ptyStatus.alive = false;
		ptyStatus.exit = ev;
	});

	params.onChild({
		pid: ptyProcess.pid ?? null,
		kill: () => safeKill(ptyProcess),
	});

	const abortHandler = () => {
		safeKill(ptyProcess);
	};
	params.signal.addEventListener("abort", abortHandler);

	// Poll state: abort / intervention / jsonl tail / hook sink.
	let interrupted = false;
	const interventionStore = getTodoSessionStore();
	const pollState = () => {
		if (!ptyStatus.alive) return false;
		if (params.signal.aborted) {
			safeKill(ptyProcess);
			return false;
		}
		const live = interventionStore.get(params.sessionId);
		if (live?.pendingIntervention?.trim()) {
			interrupted = true;
			appendRawEvent(
				params.sessionId,
				params.iteration,
				"system_init",
				"介入",
				"ユーザ介入を検知。現在のターンを中断して介入内容で再開します…",
			);
			// Forcibly end the current turn. We do not send SIGINT
			// through the PTY because the TUI treats ctrl-c as
			// "cancel prompt"; just kill the process — the next
			// iteration will re-spawn with the intervention prepended.
			safeKill(ptyProcess);
			return false;
		}
		return true;
	};

	try {
		// Wait for the JSONL file to appear.
		const jsonlStartTs = Date.now();
		while (Date.now() - jsonlStartTs < JSONL_DISCOVERY_TIMEOUT_MS) {
			if (!pollState()) break;
			const nowJsonls = listJsonl(projectDir);
			const added = nowJsonls.filter((f) => !existingJsonl.has(f));
			// When we are resuming, the JSONL file already exists — find
			// the one with matching session id, or fall back to the most
			// recently modified.
			let discovered: string | null = null;
			if (params.resumeSessionId) {
				const expected = `${params.resumeSessionId}.jsonl`;
				if (nowJsonls.includes(expected)) {
					discovered = expected;
				} else if (added.length > 0) {
					discovered = added[0];
				} else if (nowJsonls.length > 0) {
					discovered = mostRecentFile(projectDir, nowJsonls);
				}
			} else if (added.length > 0) {
				discovered = added[0];
			}
			if (discovered) {
				state.jsonlPath = path.join(projectDir, discovered);
				// When resuming, skip past the existing content so we
				// only see events produced by this turn.
				if (params.resumeSessionId) {
					try {
						state.jsonlReadOffset = fs.statSync(state.jsonlPath).size;
					} catch {
						state.jsonlReadOffset = 0;
					}
				}
				// Claude Code assigns the JSONL basename as the
				// session id in -p mode; for interactive mode the
				// basename *also* matches the runtime session id so
				// we can lift it out of the filename.
				if (!state.claudeSessionId) {
					const base = path.basename(discovered, ".jsonl");
					if (/^[0-9a-f-]{36}$/.test(base)) {
						state.claudeSessionId = base;
					}
				}
				break;
			}
			await sleep(200);
		}

		if (!state.jsonlPath) {
			return {
				result: null,
				sessionId: state.claudeSessionId,
				costUsd: null,
				numTurns: null,
				error:
					"Claude Code の JSONL ファイルが発見できませんでした (PTY 起動は成功)",
				interrupted: false,
				scheduledWakeup: null,
			};
		}

		// Wait for the TUI to settle so the first prompt isn't dropped.
		await waitForTuiReady(
			() => ptyBuffer,
			() => ptyStatus.alive,
			TUI_READY_MAX_WAIT_MS,
		);
		if (!ptyStatus.alive) {
			return ptyExitError(state, ptyStatus.exit, ptyBuffer);
		}

		// `/remote-control` must be sent BEFORE the first user prompt.
		// Otherwise the TUI may be busy rendering the response when we
		// issue it, and the slash command gets treated as plain input.
		if (params.remoteControlEnabled) {
			await activateRemoteControl(
				ptyProcess,
				() => ptyBuffer,
				(url) => {
					state.remoteControlUrl = url;
					appendRawEvent(
						params.sessionId,
						params.iteration,
						"remote_control",
						"Remote Control",
						`接続 URL: ${url}`,
					);
				},
				(errorText) => {
					appendRawEvent(
						params.sessionId,
						params.iteration,
						"remote_control_error",
						"Remote Control エラー",
						errorText,
					);
				},
			);
			// Give the TUI a moment to settle after the slash command.
			await sleep(500);
		}

		// Send the prompt via bracketed paste to preserve newlines and
		// avoid the TUI re-interpreting content like `/` as slash
		// commands when it starts a line.
		ptyProcess.write(`\x1b[200~${params.prompt}\x1b[201~`);
		await sleep(200);
		ptyProcess.write("\r");

		// Tail the JSONL and wait for Stop hook or PTY exit.
		const turnStartTs = Date.now();
		while (ptyStatus.alive) {
			if (!pollState()) break;
			await tailJsonl(state, params);
			if (hookSink.hasStopEvent()) break;
			if (Date.now() - turnStartTs > STOP_HOOK_MAX_WAIT_MS) {
				appendRawEvent(
					params.sessionId,
					params.iteration,
					"error",
					"timeout",
					"Stop hook が発火しないまま PTY ターンがタイムアウトしました",
				);
				break;
			}
			await sleep(JSONL_POLL_INTERVAL_MS);
		}

		// Drain any lines written after the last poll.
		await tailJsonl(state, params);

		if (interrupted) {
			return {
				result: state.lastAssistantText,
				sessionId: state.claudeSessionId,
				costUsd: state.costUsd,
				numTurns: state.numTurns || null,
				error: null,
				interrupted: true,
				scheduledWakeup: state.scheduledWakeup,
			};
		}

		if (
			!ptyStatus.alive &&
			(ptyStatus.exit?.exitCode ?? 0) !== 0 &&
			!state.lastAssistantText
		) {
			return ptyExitError(state, ptyStatus.exit, ptyBuffer);
		}

		return {
			result: state.lastAssistantText,
			sessionId: state.claudeSessionId,
			costUsd: state.costUsd,
			numTurns: state.numTurns || null,
			error: null,
			interrupted: false,
			scheduledWakeup: state.scheduledWakeup,
		};
	} finally {
		params.signal.removeEventListener("abort", abortHandler);
		// End the interactive session cleanly. The PTY may already have
		// exited (Stop hook path often corresponds to a long-lived TUI
		// waiting for the next prompt); tell it to exit so the next
		// iteration can start fresh with --resume.
		if (ptyStatus.alive) {
			try {
				ptyProcess.write("/exit\r");
			} catch {
				/* ignore */
			}
			await sleep(300);
			if (ptyStatus.alive) safeKill(ptyProcess);
		}
		hookSink.cleanup();
	}
}

// =============================================================================
// Helpers
// =============================================================================

interface TurnState {
	claudeSessionId: string | null;
	lastAssistantText: string | null;
	costUsd: number | null;
	numTurns: number;
	scheduledWakeup: { delayMs: number; reason: string | null } | null;
	processedEventCount: number;
	jsonlPath: string | null;
	jsonlReadOffset: number;
	remoteControlUrl: string | null;
}

function encodeCwdForClaude(cwd: string): string {
	// Claude Code replaces every non-alphanumeric character with `-`.
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function ensureDir(p: string): void {
	try {
		fs.mkdirSync(p, { recursive: true });
	} catch {
		/* ignore */
	}
}

function listJsonl(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
}

function mostRecentFile(dir: string, files: string[]): string {
	let pick = files[0];
	let pickMtime = 0;
	for (const f of files) {
		try {
			const s = fs.statSync(path.join(dir, f));
			if (s.mtimeMs > pickMtime) {
				pickMtime = s.mtimeMs;
				pick = f;
			}
		} catch {
			/* ignore */
		}
	}
	return pick;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function safeKill(p: IPty): void {
	try {
		p.kill();
	} catch {
		/* ignore */
	}
}

function buildSettingsJson(hookScriptPath: string): string {
	const settings = {
		hooks: {
			Stop: [
				{
					matcher: "",
					hooks: [{ type: "command", command: `${hookScriptPath} Stop` }],
				},
			],
		},
	};
	return JSON.stringify(settings);
}

// -----------------------------------------------------------------------------
// Hook sink — a tmp file the Stop hook appends to; the tail loop reads
// it to decide when the turn ended. Using a per-session file (not a
// socket) keeps the implementation portable across platforms and
// sidesteps SIGPIPE / nc / socat dependencies.
// -----------------------------------------------------------------------------

interface HookSink {
	scriptPath: string;
	hasStopEvent(): boolean;
	cleanup(): void;
}

function createHookSink(sessionId: string): HookSink {
	const tmpDir = path.join(os.tmpdir(), "superset-todo-pty");
	try {
		fs.mkdirSync(tmpDir, { recursive: true });
	} catch {
		/* ignore */
	}
	const eventsPath = path.join(tmpDir, `hook-${sessionId}-${Date.now()}.log`);
	const scriptPath = path.join(tmpDir, `hook-${sessionId}-${Date.now()}.sh`);
	try {
		fs.writeFileSync(eventsPath, "");
	} catch {
		/* ignore */
	}
	// Minimal POSIX shell script; stdin is a JSON object provided by
	// Claude Code's hook runner, which we echo into the sink file so
	// the daemon can see it. We intentionally don't require jq.
	const script = `#!/bin/sh
set -e
EVENT="$1"
INPUT=$(cat)
printf '{"event":"%s","input":%s}\\n' "$EVENT" "$INPUT" >> ${escapeShell(
		eventsPath,
	)}
exit 0
`;
	try {
		fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	} catch (err) {
		console.warn("[todo-daemon:pty] failed to write hook script:", err);
	}
	return {
		scriptPath,
		hasStopEvent: () => {
			try {
				return fs.readFileSync(eventsPath, "utf8").includes('"event":"Stop"');
			} catch {
				return false;
			}
		},
		cleanup: () => {
			try {
				fs.unlinkSync(scriptPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(eventsPath);
			} catch {
				/* ignore */
			}
		},
	};
}

function escapeShell(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

// -----------------------------------------------------------------------------
// TUI ready detection
// -----------------------------------------------------------------------------

async function waitForTuiReady(
	getBuffer: () => string,
	isAlive: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let lastLen = 0;
	let stableAt = Date.now();
	while (Date.now() < deadline) {
		await sleep(200);
		if (!isAlive()) return false;
		const buf = getBuffer();
		if (buf.length === lastLen) {
			if (Date.now() - stableAt >= TUI_READY_IDLE_MS) return true;
		} else {
			lastLen = buf.length;
			stableAt = Date.now();
		}
	}
	return false;
}

// -----------------------------------------------------------------------------
// /remote-control flow
// -----------------------------------------------------------------------------

async function activateRemoteControl(
	ptyProc: IPty,
	getBuffer: () => string,
	onUrl: (url: string) => void,
	onError: (msg: string) => void,
): Promise<void> {
	const bufferLenBefore = getBuffer().length;
	try {
		ptyProc.write("/remote-control\r");
	} catch (err) {
		onError(
			`/remote-control の送信に失敗: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return;
	}
	const deadline = Date.now() + REMOTE_CONTROL_URL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(250);
		const snippet = getBuffer().slice(bufferLenBefore);
		const cleaned = stripAnsi(snippet);
		const m = cleaned.match(REMOTE_CONTROL_URL_RE);
		if (m?.[0]) {
			onUrl(m[0]);
			return;
		}
		const errM = cleaned.match(
			/Remote Control [^\n]*(?:requires|disabled|not enabled|not yet enabled|failed)[^\n]*/i,
		);
		if (errM) {
			onError(errM[0].trim());
			return;
		}
	}
	onError("Remote Control の URL を取得できませんでした (タイムアウト)");
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes from PTY output is the whole point
	const csi = /\x1b\[[0-9;?]*[A-Za-z]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminator BEL (0x07) is the spec-defined end of an OSC sequence
	const osc = /\x1b\][^\x07]*\x07/g;
	return s.replace(csi, "").replace(osc, "");
}

// -----------------------------------------------------------------------------
// JSONL tail
// -----------------------------------------------------------------------------

async function tailJsonl(
	state: TurnState,
	params: PtyTurnParams,
): Promise<void> {
	if (!state.jsonlPath) return;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(state.jsonlPath);
	} catch {
		return;
	}
	if (stat.size <= state.jsonlReadOffset) return;
	const len = stat.size - state.jsonlReadOffset;
	let buf: Buffer;
	let fd: number | null = null;
	try {
		fd = fs.openSync(state.jsonlPath, "r");
		buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, state.jsonlReadOffset);
	} catch {
		if (fd != null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
		return;
	} finally {
		if (fd != null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
	state.jsonlReadOffset += len;
	const text = buf.toString("utf8");
	const lines = text.split("\n");
	// The last chunk may be a partial line; rewind so we re-read it
	// next poll. This keeps the parser simple — no in-memory line
	// reassembly across poll cycles.
	if (text.length > 0 && !text.endsWith("\n")) {
		const lastLine = lines.pop() ?? "";
		state.jsonlReadOffset -= Buffer.byteLength(lastLine, "utf8");
	}
	const events: TodoStreamEvent[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch {
			continue;
		}
		const classified = classifyJsonlRecord(payload);
		if (classified.sessionId && !state.claudeSessionId) {
			state.claudeSessionId = classified.sessionId;
		}
		if (classified.scheduledWakeup) {
			state.scheduledWakeup = classified.scheduledWakeup;
		}
		if (classified.assistantText) {
			state.lastAssistantText = classified.assistantText;
		}
		if (classified.usage) {
			state.numTurns += 1;
		}
		for (const e of classified.events) {
			events.push({
				id: randomUUID(),
				ts: Date.now(),
				iteration: params.iteration,
				kind: e.kind,
				label: e.label,
				text: e.text,
				toolUseId: e.toolUseId,
				parentToolUseId: e.parentToolUseId,
			});
		}
	}
	if (events.length > 0) {
		getTodoSessionStore().appendStreamEvents(params.sessionId, events);
	}
}

// -----------------------------------------------------------------------------
// JSONL record classifier
// -----------------------------------------------------------------------------

interface ClassifiedJsonlRecord {
	sessionId: string | null;
	assistantText: string | null;
	usage: boolean;
	scheduledWakeup: { delayMs: number; reason: string | null } | null;
	events: Array<{
		kind: TodoStreamEventKind;
		label: string;
		text: string;
		toolUseId?: string;
		parentToolUseId?: string;
	}>;
}

function classifyJsonlRecord(payload: unknown): ClassifiedJsonlRecord {
	const empty: ClassifiedJsonlRecord = {
		sessionId: null,
		assistantText: null,
		usage: false,
		scheduledWakeup: null,
		events: [],
	};
	if (typeof payload !== "object" || payload === null) return empty;
	const rec = payload as Record<string, unknown>;
	const type = typeof rec.type === "string" ? (rec.type as string) : "";
	const sessionId =
		typeof rec.sessionId === "string" ? (rec.sessionId as string) : null;
	const parentToolUseId =
		typeof rec.parentToolUseId === "string"
			? (rec.parentToolUseId as string)
			: undefined;

	if (type === "assistant") {
		const msg = rec.message as { content?: unknown } | undefined;
		const text = extractText(msg?.content);
		const tool = extractToolUse(msg?.content);
		const wakeup = extractScheduledWakeup(msg?.content);
		const hasUsage =
			typeof msg === "object" &&
			msg !== null &&
			typeof (msg as { usage?: unknown }).usage === "object";
		const events: ClassifiedJsonlRecord["events"] = [];
		if (text) {
			events.push({
				kind: "assistant_text",
				label: "Claude",
				text,
				parentToolUseId,
			});
		}
		if (tool) {
			events.push({
				kind: "tool_use",
				label: tool.label,
				text: tool.text,
				toolUseId: tool.id,
				parentToolUseId,
			});
		}
		return {
			sessionId,
			assistantText: text,
			usage: hasUsage,
			scheduledWakeup: wakeup,
			events,
		};
	}

	if (type === "user") {
		const msg = rec.message as { content?: unknown } | undefined;
		const result = extractToolResult(msg?.content);
		if (result) {
			return {
				...empty,
				sessionId,
				events: [
					{
						kind: "tool_result",
						label: "tool result",
						text: truncate(result.text, 400),
						toolUseId: result.toolUseId,
						parentToolUseId,
					},
				],
			};
		}
		return empty;
	}

	if (type === "system") {
		const subtype =
			typeof rec.subtype === "string" ? (rec.subtype as string) : "";
		if (subtype === "init") {
			return {
				...empty,
				sessionId,
				events: [
					{
						kind: "system_init",
						label: "init",
						text: `session ${sessionId ?? "?"} 準備完了`,
					},
				],
			};
		}
		return empty;
	}

	return empty;
}

function extractText(content: unknown): string | null {
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

function extractToolUse(
	content: unknown,
): { label: string; text: string; id: string | undefined } | null {
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type !== "tool_use") continue;
		const name = typeof rec.name === "string" ? (rec.name as string) : "tool";
		const id = typeof rec.id === "string" ? (rec.id as string) : undefined;
		const input = rec.input;
		return { label: name, text: summarizeToolInput(name, input), id };
	}
	return null;
}

function extractScheduledWakeup(
	content: unknown,
): { delayMs: number; reason: string | null } | null {
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

function extractToolResult(
	content: unknown,
): { text: string; toolUseId: string | undefined } | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	let toolUseId: string | undefined;
	let saw = false;
	let imageCount = 0;
	let otherCount = 0;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const rec = part as Record<string, unknown>;
		if (rec.type !== "tool_result") continue;
		saw = true;
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
					otherCount += 1;
				}
			}
		}
	}
	if (!saw) return null;
	const joined = parts.join("\n").trim();
	if (joined.length > 0) return { text: joined, toolUseId };
	const summary: string[] = [];
	if (imageCount > 0) {
		summary.push(imageCount === 1 ? "[画像 1 件]" : `[画像 ${imageCount} 件]`);
	}
	if (otherCount > 0) {
		summary.push(`[非テキストブロック ${otherCount} 件]`);
	}
	return {
		text: summary.length > 0 ? summary.join(" ") : "(空の結果)",
		toolUseId,
	};
}

function summarizeToolInput(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return name;
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

// -----------------------------------------------------------------------------
// Stream event append helpers
// -----------------------------------------------------------------------------

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

function ptyExitError(
	state: TurnState,
	exit: { exitCode: number; signal?: number } | null,
	ptyBuffer: string,
): PtyTurnResult {
	const tail = stripAnsi(ptyBuffer).split("\n").slice(-8).join("\n").trim();
	return {
		result: state.lastAssistantText,
		sessionId: state.claudeSessionId,
		costUsd: state.costUsd,
		numTurns: state.numTurns || null,
		error: `claude (PTY) が exit code ${exit?.exitCode ?? "?"} で終了しました${
			tail ? `:\n${tail}` : ""
		}`,
		interrupted: false,
		scheduledWakeup: state.scheduledWakeup,
	};
}

// `extractAttachmentPaths` is exported to keep the same affordance
// supervisor-engine offers; callers can pre-inspect a prompt for
// attachment chips without duplicating the regex.
export function extractAttachmentPaths(
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
