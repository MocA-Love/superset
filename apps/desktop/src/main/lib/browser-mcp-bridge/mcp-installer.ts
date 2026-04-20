import { execFile as execFileCb } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SERVER_NAME = "superset-browser";

export type McpTarget = "claude" | "codex";

export interface InstallTargetState {
	/** CLI binary found on PATH. */
	cliFound: boolean;
	/**
	 * `superset-browser` is already registered. `matchesExpected` is true
	 * when the registered command + args match what the Superset app would
	 * install today — if false, re-installing the entry will correct a
	 * stale legacy registration (e.g. the old `desktop-mcp` bin name).
	 */
	installed: boolean;
	matchesExpected: boolean;
	/** Raw command string currently registered, for display only. */
	currentCommand: string | null;
}

export interface InstallState {
	claude: InstallTargetState;
	codex: InstallTargetState;
}

interface ExpectedCommand {
	command: string;
	args: string[];
}

async function which(binary: string): Promise<boolean> {
	try {
		const { stdout } = await execFile(
			process.platform === "win32" ? "where" : "which",
			[binary],
		);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

function commandsEqual(
	a: { command: string; args: string[] },
	b: ExpectedCommand,
): boolean {
	if (a.command !== b.command) return false;
	if (a.args.length !== b.args.length) return false;
	for (let i = 0; i < a.args.length; i++) {
		if (a.args[i] !== b.args[i]) return false;
	}
	return true;
}

async function probeClaude(
	expected: ExpectedCommand,
): Promise<InstallTargetState> {
	const cliFound = await which("claude");
	if (!cliFound) {
		return {
			cliFound: false,
			installed: false,
			matchesExpected: false,
			currentCommand: null,
		};
	}
	try {
		const { stdout } = await execFile("claude", ["mcp", "get", SERVER_NAME]);
		const lines = stdout.split("\n");
		const commandLine = lines.find((l) => /^\s*command:/i.test(l));
		const argsLine = lines.find((l) => /^\s*args:/i.test(l));
		const command = commandLine?.split(":").slice(1).join(":").trim() ?? "";
		const argsRaw = argsLine?.split(":").slice(1).join(":").trim() ?? "";
		const args = argsRaw.length > 0 ? argsRaw.split(/\s+/) : [];
		return {
			cliFound: true,
			installed: true,
			matchesExpected: commandsEqual({ command, args }, expected),
			currentCommand: [command, ...args].filter(Boolean).join(" "),
		};
	} catch {
		return {
			cliFound: true,
			installed: false,
			matchesExpected: false,
			currentCommand: null,
		};
	}
}

function probeCodex(expected: ExpectedCommand): InstallTargetState {
	const cliFound = true; // Probed separately when install is requested.
	const configPath = join(homedir(), ".codex", "config.toml");
	let contents: string;
	try {
		contents = readFileSync(configPath, "utf8");
	} catch {
		return {
			cliFound,
			installed: false,
			matchesExpected: false,
			currentCommand: null,
		};
	}
	const nameRe = new RegExp(
		String.raw`(^|\n)\[\s*mcp_servers\.(?:${SERVER_NAME}|["']${SERVER_NAME}["'])\s*\]\s*\n([\s\S]*?)(?=\n\[|$)`,
	);
	const match = contents.match(nameRe);
	if (!match) {
		return {
			cliFound,
			installed: false,
			matchesExpected: false,
			currentCommand: null,
		};
	}
	const body = match[2]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	const commandLine = body.find((l) => /^command\s*=/.test(l));
	const argsLine = body.find((l) => /^args\s*=/.test(l));
	const commandMatch = commandLine?.match(/^command\s*=\s*"([^"]*)"/);
	const command = commandMatch?.[1] ?? "";
	const argsMatches =
		argsLine?.match(/"([^"]*)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
	return {
		cliFound,
		installed: true,
		matchesExpected: commandsEqual({ command, args: argsMatches }, expected),
		currentCommand: [command, ...argsMatches].filter(Boolean).join(" "),
	};
}

export async function getInstallState(
	expected: ExpectedCommand,
): Promise<InstallState> {
	const [claude, codexCliFound] = await Promise.all([
		probeClaude(expected),
		which("codex"),
	]);
	const codexBase = probeCodex(expected);
	return {
		claude,
		codex: { ...codexBase, cliFound: codexCliFound },
	};
}

async function installForClaude(expected: ExpectedCommand): Promise<void> {
	// `claude mcp add` fails if the name already exists; remove first so
	// the call is idempotent and also corrects stale command paths.
	await execFile("claude", ["mcp", "remove", SERVER_NAME]).catch(() => {});
	await execFile("claude", [
		"mcp",
		"add",
		SERVER_NAME,
		"-s",
		"user",
		"--",
		expected.command,
		...expected.args,
	]);
}

async function installForCodex(expected: ExpectedCommand): Promise<void> {
	await execFile("codex", ["mcp", "remove", SERVER_NAME]).catch(() => {});
	await execFile("codex", [
		"mcp",
		"add",
		SERVER_NAME,
		"--",
		expected.command,
		...expected.args,
	]);
}

export async function installMcp(
	targets: readonly McpTarget[],
	expected: ExpectedCommand,
): Promise<Record<McpTarget, { ok: boolean; error: string | null }>> {
	const results: Record<McpTarget, { ok: boolean; error: string | null }> = {
		claude: { ok: false, error: null },
		codex: { ok: false, error: null },
	};
	for (const target of targets) {
		try {
			if (target === "claude") await installForClaude(expected);
			else await installForCodex(expected);
			results[target] = { ok: true, error: null };
		} catch (error) {
			results[target] = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return results;
}
