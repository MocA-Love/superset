import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTerminalSessionInternal } from "../../../../terminal/terminal";
import type { HostServiceContext } from "../../../../types";
import type { TerminalDescriptor } from "./types";

interface SetupScriptCandidate {
	ext: string;
	buildCommand: (path: string) => string;
}

const POSIX_CANDIDATES: SetupScriptCandidate[] = [
	{ ext: "sh", buildCommand: (p) => `bash ${singleQuote(p)}` },
];

const WINDOWS_CANDIDATES: SetupScriptCandidate[] = [
	{
		ext: "ps1",
		buildCommand: (p) =>
			`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${doubleQuote(p)}`,
	},
	{ ext: "cmd", buildCommand: (p) => `cmd.exe /c ${doubleQuote(p)}` },
	{ ext: "bat", buildCommand: (p) => `cmd.exe /c ${doubleQuote(p)}` },
];

export function startSetupTerminalIfPresent(args: {
	ctx: HostServiceContext;
	workspaceId: string;
	worktreePath: string;
}): { terminal: TerminalDescriptor | null; warning: string | null } {
	const candidates =
		process.platform === "win32" ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;

	for (const candidate of candidates) {
		const setupScriptPath = join(
			args.worktreePath,
			".superset",
			`setup.${candidate.ext}`,
		);
		if (!existsSync(setupScriptPath)) continue;

		const terminalId = crypto.randomUUID();
		const result = createTerminalSessionInternal({
			terminalId,
			workspaceId: args.workspaceId,
			db: args.ctx.db,
			eventBus: args.ctx.eventBus,
			initialCommand: candidate.buildCommand(setupScriptPath),
		});
		if ("error" in result) {
			return {
				terminal: null,
				warning: `Failed to start setup terminal: ${result.error}`,
			};
		}

		return {
			terminal: {
				id: terminalId,
				role: "setup",
				label: "Workspace Setup",
			},
			warning: null,
		};
	}

	return { terminal: null, warning: null };
}

/** POSIX single-quote escape: safe for any path passed through a shell. */
function singleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Windows double-quote escape: safe for cmd.exe and PowerShell -File args. */
function doubleQuote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}
