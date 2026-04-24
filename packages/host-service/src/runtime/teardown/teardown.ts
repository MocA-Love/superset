import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TEARDOWN_TIMEOUT_MS } from "@superset/shared/constants";
import type { HostDb } from "../../db";
import {
	createTerminalSessionInternal,
	disposeSession,
} from "../../terminal/terminal";

export { TEARDOWN_TIMEOUT_MS };

export const TEARDOWN_SCRIPT_REL_PATH = ".superset/teardown.sh";

interface TeardownScriptCandidate {
	relativePath: string;
	buildCommand: (path: string) => string;
}

const POSIX_TEARDOWN_CANDIDATES: TeardownScriptCandidate[] = [
	{
		relativePath: TEARDOWN_SCRIPT_REL_PATH,
		buildCommand: (p) => `bash ${singleQuote(p)} ; exit $?`,
	},
];

const WINDOWS_TEARDOWN_CANDIDATES: TeardownScriptCandidate[] = [
	{
		relativePath: ".superset/teardown.ps1",
		buildCommand: (p) =>
			`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${doubleQuote(p)}`,
	},
	{
		relativePath: ".superset/teardown.cmd",
		buildCommand: (p) => `cmd.exe /c ${doubleQuote(p)}`,
	},
	{
		relativePath: ".superset/teardown.bat",
		buildCommand: (p) => `cmd.exe /c ${doubleQuote(p)}`,
	},
];

const OUTPUT_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 2_000;

export type TeardownResult =
	| { status: "ok"; output?: string }
	| { status: "skipped" }
	| {
			status: "failed";
			exitCode: number | null;
			/** Unix signal number, or null on normal exit. */
			signal: number | null;
			timedOut: boolean;
			/** Raw PTY bytes — shell output including ANSI. Renderer strips for display. */
			outputTail: string;
	  };

interface RunTeardownOptions {
	db: HostDb;
	workspaceId: string;
	worktreePath: string;
	timeoutMs?: number;
}

/**
 * Runs `.superset/teardown.sh` inside the workspace, reusing the same
 * terminal primitive v2 uses for interactive sessions. This gives the
 * script full environment parity with the user's terminals (login shell
 * rcfiles, PATH, nvm/rbenv, etc.), matching how setup.sh runs.
 *
 * Silent by design — the PTY session is transient and not surfaced as a
 * visible pane. The renderer only sees the output tail on failure.
 */
export async function runTeardown({
	db,
	workspaceId,
	worktreePath,
	timeoutMs = TEARDOWN_TIMEOUT_MS,
}: RunTeardownOptions): Promise<TeardownResult> {
	const candidates =
		process.platform === "win32"
			? WINDOWS_TEARDOWN_CANDIDATES
			: POSIX_TEARDOWN_CANDIDATES;

	let match: { path: string; buildCommand: (p: string) => string } | null =
		null;
	for (const candidate of candidates) {
		const candidatePath = join(worktreePath, candidate.relativePath);
		if (existsSync(candidatePath)) {
			match = { path: candidatePath, buildCommand: candidate.buildCommand };
			break;
		}
	}
	if (!match) return { status: "skipped" };

	const scriptPath = match.path;

	const terminalId = randomUUID();
	// Shell-specific invocation. Paths are quoted so interpolation is
	// impossible on both POSIX and Windows shells.
	const initialCommand = match.buildCommand(scriptPath);

	const session = createTerminalSessionInternal({
		terminalId,
		workspaceId,
		db,
		initialCommand,
	});
	if ("error" in session) {
		return {
			status: "failed",
			exitCode: null,
			signal: null,
			timedOut: false,
			outputTail: `Failed to start teardown session: ${session.error}`,
		};
	}

	let tail = "";
	const appendTail = (chunk: string) => {
		tail += chunk;
		if (tail.length > OUTPUT_TAIL_BYTES) {
			tail = tail.slice(-OUTPUT_TAIL_BYTES);
		}
	};
	const dataDisposer = session.pty.onData(appendTail);

	return new Promise<TeardownResult>((resolve) => {
		let settled = false;
		let timedOut = false;

		const settle = (result: TeardownResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				dataDisposer.dispose();
			} catch {
				// already disposed
			}
			disposeSession(terminalId, db);
			resolve(result);
		};

		session.pty.onExit(({ exitCode, signal }) => {
			if (exitCode === 0 && !timedOut) {
				settle({ status: "ok", output: tail || undefined });
				return;
			}
			settle({
				status: "failed",
				exitCode: exitCode ?? null,
				signal: signal ?? null,
				timedOut,
				outputTail: tail,
			});
		});

		const timer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			appendTail(`\n[teardown timed out after ${timeoutMs}ms]\n`);
			try {
				session.pty.kill();
			} catch {
				// PTY may already be dead
			}
			// Hard-stop: if onExit doesn't fire shortly after kill (zombie PTY),
			// settle the promise directly so workspaceCleanup.destroy never hangs.
			setTimeout(() => {
				settle({
					status: "failed",
					exitCode: null,
					signal: null,
					timedOut: true,
					outputTail: tail,
				});
			}, KILL_GRACE_MS).unref();
		}, timeoutMs);
		timer.unref();
	});
}

/** POSIX single-quote escape: safe for any byte sequence in a path. */
function singleQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Windows double-quote escape: safe for cmd.exe and PowerShell -File args. */
function doubleQuote(s: string): string {
	return `"${s.replaceAll('"', '""')}"`;
}
