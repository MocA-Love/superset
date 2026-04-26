import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
	browserAutomationBindings,
	projects,
	type SelectBrowserAutomationBinding,
	workspaces,
	worktrees,
} from "@superset/local-db";
import {
	getProcessCommand,
	getProcessName,
	getProcessTree,
} from "@superset/port-scanner";
import { observable } from "@trpc/server/observable";
import { and, eq, ne } from "drizzle-orm";
import { app } from "electron";
import { localDb } from "main/lib/local-db";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Browser automation bindings router.
 *
 * Bindings persist in local-db so they survive app restarts: the terminal
 * daemon re-attaches terminal panes and TODO-Agent sessions keep running,
 * so losing the binding would force a re-connect on every launch.
 *
 * Also exposes MCP-readiness detection by reading the user's agent config
 * files (Claude Code / Codex) for the `superset-browser` entry.
 */

export type BrowserAutomationBinding = SelectBrowserAutomationBinding;

class BindingStore {
	private readonly emitter = new EventEmitter();

	constructor() {
		// One subscription per renderer hook instance; a workspace with many
		// open panes can blow past Node's 10-listener default otherwise.
		this.emitter.setMaxListeners(0);
	}

	list(): BrowserAutomationBinding[] {
		return localDb.select().from(browserAutomationBindings).all();
	}

	get(paneId: string): BrowserAutomationBinding | null {
		return (
			localDb
				.select()
				.from(browserAutomationBindings)
				.where(eq(browserAutomationBindings.paneId, paneId))
				.get() ?? null
		);
	}

	getBySessionId(sessionId: string): BrowserAutomationBinding | null {
		return (
			localDb
				.select()
				.from(browserAutomationBindings)
				.where(eq(browserAutomationBindings.sessionId, sessionId))
				.get() ?? null
		);
	}

	set(
		paneId: string,
		sessionId: string,
		sessionKind: string,
	): { previousPaneId: string | null } {
		// Remove any existing binding that points at the same session on a
		// different pane so we enforce 1 session ↔ 1 pane.
		const existingOtherPane = localDb
			.select()
			.from(browserAutomationBindings)
			.where(
				and(
					eq(browserAutomationBindings.sessionId, sessionId),
					ne(browserAutomationBindings.paneId, paneId),
				),
			)
			.get();
		const previousPaneId = existingOtherPane?.paneId ?? null;
		if (previousPaneId) {
			localDb
				.delete(browserAutomationBindings)
				.where(eq(browserAutomationBindings.paneId, previousPaneId))
				.run();
		}
		const row = {
			paneId,
			sessionId,
			sessionKind,
			connectedAt: Date.now(),
		};
		// Drizzle SQLite upsert via onConflictDoUpdate
		localDb
			.insert(browserAutomationBindings)
			.values(row)
			.onConflictDoUpdate({
				target: browserAutomationBindings.paneId,
				set: {
					sessionId: row.sessionId,
					sessionKind: row.sessionKind,
					connectedAt: row.connectedAt,
				},
			})
			.run();
		this.emitChange();
		return { previousPaneId };
	}

	remove(paneId: string): boolean {
		const result = localDb
			.delete(browserAutomationBindings)
			.where(eq(browserAutomationBindings.paneId, paneId))
			.run();
		if (result.changes > 0) {
			this.emitChange();
			return true;
		}
		return false;
	}

	private emitChange() {
		this.emitter.emit("change", this.list());
	}

	onChange(cb: (bindings: BrowserAutomationBinding[]) => void): () => void {
		this.emitter.on("change", cb);
		return () => {
			this.emitter.off("change", cb);
		};
	}
}

export const bindingStore = new BindingStore();

const SERVER_NAME = "superset-browser";

function isEnabledMcpEntry(
	value: unknown,
	expected?: { command: string; args: string[] },
): boolean {
	if (value == null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	if (entry.disabled === true) return false;
	const hasShape =
		typeof entry.command === "string" ||
		typeof entry.url === "string" ||
		Array.isArray(entry.args);
	if (!hasShape) return false;
	// When we know the canonical command the app wants to install (the
	// bundled binary path), require the registered entry to match. That
	// way a legacy `desktop-mcp` / `superset-browser-mcp` registration
	// isn't reported as ready and the UI prompts the user to re-install
	// against the current bundled binary. Absence of expected means the
	// shape check alone is enough (for callers that do not care yet).
	if (!expected) return true;
	if (entry.command !== expected.command) return false;
	const rawArgs = Array.isArray(entry.args)
		? (entry.args as unknown[]).map(String)
		: [];
	if (rawArgs.length !== expected.args.length) return false;
	for (let i = 0; i < rawArgs.length; i++) {
		if (rawArgs[i] !== expected.args[i]) return false;
	}
	return true;
}

/**
 * Claude Code writes MCP server definitions into several possible files:
 *   - `~/.claude.json` (user scope, written by `claude mcp add`)
 *   - `~/.claude/settings.json` (legacy / hooks-oriented)
 *   - `<project>/.mcp.json` (project scope)
 * We inspect all of them and accept the server if any file contains an
 * enabled entry. Each file is parsed as JSON and we look under
 * `mcpServers[name]`.
 */
function mcpServersInObject(obj: unknown): Record<string, unknown> | null {
	if (!obj || typeof obj !== "object") return null;
	const candidate = (obj as Record<string, unknown>).mcpServers;
	if (!candidate || typeof candidate !== "object") return null;
	return candidate as Record<string, unknown>;
}

/**
 * Claude `~/.claude.json` holds MCP entries in two places:
 *   - top-level `mcpServers[name]` (user scope)
 *   - `projects[<path>].mcpServers[name]` (local scope, default for
 *     `claude mcp add`)
 * We accept either. Other config files (`.claude/settings.json`,
 * `<project>/.mcp.json`) only use the top-level shape.
 */
function detectClaudeMcpInFile(
	filePath: string,
	opts?: {
		workspacePaths?: readonly string[];
		expected?: { command: string; args: string[] };
	},
): boolean {
	try {
		const contents = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(contents) as unknown;
		const topLevel = mcpServersInObject(parsed);
		if (topLevel && isEnabledMcpEntry(topLevel[SERVER_NAME], opts?.expected))
			return true;
		const projects = (parsed as Record<string, unknown> | null)?.projects;
		if (projects && typeof projects === "object" && opts?.workspacePaths) {
			for (const wsPath of opts.workspacePaths) {
				const project = (projects as Record<string, unknown>)[wsPath];
				const entries = mcpServersInObject(project);
				if (entries && isEnabledMcpEntry(entries[SERVER_NAME], opts?.expected))
					return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

function detectClaudeMcp(
	paths: readonly string[],
	opts?: {
		workspacePaths?: readonly string[];
		expected?: { command: string; args: string[] };
	},
): boolean {
	return paths.some((p) => detectClaudeMcpInFile(p, opts));
}

/**
 * Resolve the `.mcp.json` path for each workspace keyed by workspaceId,
 * so per-project MCP definitions (output of `claude mcp add -s project`)
 * can be considered per-session without letting one configured project
 * make sessions from other projects look ready.
 */
interface WorkspacePathInfo {
	base: string;
	mcpJsonPath: string;
}

function collectWorkspacePathsByWorkspaceId(): Record<
	string,
	WorkspacePathInfo
> {
	try {
		const rows = localDb
			.select({
				workspaceId: workspaces.id,
				worktreePath: worktrees.path,
				mainRepoPath: projects.mainRepoPath,
			})
			.from(workspaces)
			.leftJoin(projects, eq(projects.id, workspaces.projectId))
			.leftJoin(worktrees, eq(worktrees.id, workspaces.worktreeId))
			.all();
		const out: Record<string, WorkspacePathInfo> = {};
		for (const row of rows) {
			const base = row.worktreePath ?? row.mainRepoPath ?? null;
			if (row.workspaceId && base) {
				out[row.workspaceId] = {
					base,
					mcpJsonPath: join(base, ".mcp.json"),
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Codex: ~/.codex/config.toml uses `[mcp_servers.<name>]` table sections.
 * We avoid pulling in a TOML parser just for this one check — instead we
 * isolate the `[mcp_servers.superset-browser]` section and verify it has
 * at least one usable field (`command`, `url`, `args`) and is not marked
 * `disabled = true`. Comment lines (starting with `#`) are ignored.
 */
function unescapeTomlBasicString(raw: string): string {
	// Minimal TOML basic-string unescape: handles the standard sequences
	// users actually write for Windows paths (backslashes) and shell
	// invocations. Not a full TOML parser but enough for command / args
	// values that come out of `codex mcp add`.
	return raw.replace(
		/\\(["\\bfnrt]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
		(_, esc) => {
			switch (esc) {
				case "\\":
					return "\\";
				case '"':
					return '"';
				case "b":
					return "\b";
				case "f":
					return "\f";
				case "n":
					return "\n";
				case "r":
					return "\r";
				case "t":
					return "\t";
				default: {
					const hex = esc.slice(1);
					const code = Number.parseInt(hex, 16);
					return Number.isFinite(code) ? String.fromCodePoint(code) : "";
				}
			}
		},
	);
}

function extractTomlStrings(line: string | undefined): string[] {
	if (!line) return [];
	const out: string[] = [];
	// Match basic strings "…" (with escapes) and literal strings '…'
	// (no escape processing). Both are valid TOML.
	const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
	for (let m = re.exec(line); m !== null; m = re.exec(line)) {
		if (m[1] !== undefined) out.push(unescapeTomlBasicString(m[1]));
		else if (m[2] !== undefined) out.push(m[2]);
	}
	return out;
}

function parseFirstTomlString(line: string | undefined): string {
	return extractTomlStrings(line)[0] ?? "";
}

function parseAllTomlStrings(line: string | undefined): string[] {
	return extractTomlStrings(line);
}

function detectCodexMcp(
	filePath: string,
	expected?: { command: string; args: string[] },
): boolean {
	try {
		const contents = readFileSync(filePath, "utf8");
		// TOML accepts several equivalent header forms for the same table.
		const q = `["']`;
		const name = SERVER_NAME.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
		const sectionRe = new RegExp(
			String.raw`(^|\n)\[\s*(?:mcp_servers\.(?:${name}|${q}${name}${q})|${q}mcp_servers${q}\.${name})\s*\]\s*\n([\s\S]*?)(?=\n\[|$)`,
		);
		const match = contents.match(sectionRe);
		if (!match) return false;
		const body = match[2]
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
		if (body.some((line) => /^disabled\s*=\s*true\b/.test(line))) return false;
		const hasShape = body.some((line) => /^(command|url|args)\s*=/.test(line));
		if (!hasShape) return false;
		if (!expected) return true;
		const commandLine = body.find((line) => /^command\s*=/.test(line));
		const argsLine = body.find((line) => /^args\s*=/.test(line));
		const command = parseFirstTomlString(commandLine);
		const args = parseAllTomlStrings(argsLine);
		if (command !== expected.command) return false;
		if (args.length !== expected.args.length) return false;
		for (let i = 0; i < args.length; i++) {
			if (args[i] !== expected.args[i]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

const CLAUDE_USER_JSON_PATH = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS_JSON_PATH = join(homedir(), ".claude", "settings.json");
const CLAUDE_CONFIG_PATHS = [CLAUDE_USER_JSON_PATH, CLAUDE_SETTINGS_JSON_PATH];
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

export interface TerminalAgentSession {
	paneId: string;
	workspaceId: string;
	pid: number;
	provider: "Claude" | "Codex";
	command: string;
	lastAttachedAt?: string;
}

/**
 * Walk every live terminal session's PTY process tree and return the ones
 * that currently have a `claude` or `codex` child process. Used so the
 * Browser Automation UI can treat "the claude I started in this terminal
 * tab" as an LLM session that is connectable to a browser pane.
 */
async function detectTerminalAgentSessions(): Promise<TerminalAgentSession[]> {
	let sessions: Awaited<
		ReturnType<ReturnType<typeof getTerminalHostClient>["listSessions"]>
	>["sessions"];
	try {
		const client = getTerminalHostClient();
		const response = await client.listSessions();
		sessions = response.sessions;
	} catch (error) {
		// Terminal-host daemon is intermittently unavailable (restart races,
		// IPC errors). Degrade gracefully so liveness data for non-terminal
		// bindings is still returned instead of rejecting the whole query.
		console.warn(
			"[browser-automation] terminal listSessions failed, skipping terminal probe:",
			error,
		);
		return [];
	}
	const out: TerminalAgentSession[] = [];
	await Promise.all(
		sessions.map(async (s) => {
			if (!s.isAlive || typeof s.pid !== "number") return;
			const pids = await getProcessTree(s.pid);
			// Skip the shell itself (root pid). For each child we read BOTH
			// comm (short name) AND args (full argv). Many claude / codex
			// installs appear as comm=node with args=node /usr/local/.../claude,
			// so a comm-only match misses them.
			const probes = await Promise.all(
				pids
					.filter((p) => p !== s.pid)
					.map(async (p) => {
						const [name, command] = await Promise.all([
							getProcessName(p),
							getProcessCommand(p),
						]);
						return { pid: p, name, command };
					}),
			);
			const match = probes.find((p) => classifyAgent(p.name, p.command));
			if (!match) return;
			const provider = classifyAgent(match.name, match.command);
			if (!provider) return;
			out.push({
				paneId: s.paneId,
				workspaceId: s.workspaceId,
				pid: match.pid,
				provider,
				command: match.name,
				lastAttachedAt: s.lastAttachedAt,
			});
		}),
	);
	return out;
}

/**
 * Is the process a `claude` or `codex` CLI? Checks both the short
 * process name and the full argv. The CLIs are commonly installed as
 * thin wrappers that `exec node /path/to/bin/claude ...`, which makes
 * the short name "node" — argv catches that.
 */
function classifyAgent(
	name: string,
	command: string,
): "Claude" | "Codex" | null {
	const lname = name.toLowerCase();
	if (lname === "codex") return "Codex";
	if (lname === "claude") return "Claude";
	// Fall back to argv matching. Only accept tokens whose basename is
	// exactly claude / codex (so a random node script that has "claude"
	// as a substring does not match).
	const tokens = command.split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
		if (base === "codex" || base === "codex.js") return "Codex";
		if (base === "claude" || base === "claude.js") return "Claude";
	}
	return null;
}

/**
 * Resolve the `superset-browser-mcp` bin that a Claude / Codex session
 * should spawn. In dev we return `bun run <repo>/packages/superset-browser-mcp/src/bin.ts`
 * so the snippet shown in the Connect modal is copy-pasteable without
 * requiring a global install. In packaged production builds the source
 * tree is not available; we fall back to the bare name so a future
 * published npm package still produces a usable snippet.
 */
function resolveSupersetBrowserMcpCommand(): {
	command: string;
	args: string[];
	available: boolean;
} {
	if (app.isPackaged) {
		// Standalone binary shipped alongside the app (see electron-builder
		// extraResources `to: "resources/superset-browser-mcp"`). On macOS
		// process.resourcesPath is <app>/Contents/Resources, so the final
		// layout is <app>/Contents/Resources/resources/superset-browser-mcp/.
		const binName =
			process.platform === "win32"
				? "superset-browser-mcp.exe"
				: "superset-browser-mcp";
		const binPath = join(
			process.resourcesPath,
			"resources",
			"superset-browser-mcp",
			binName,
		);
		if (existsSync(binPath)) {
			return { command: binPath, args: [], available: true };
		}
		return {
			command: binPath,
			args: [],
			available: false,
		};
	}
	const repoRoot = resolvePath(app.getAppPath(), "../..");
	const binPath = join(repoRoot, "packages/superset-browser-mcp/src/bin.ts");
	if (existsSync(binPath)) {
		return { command: "bun", args: ["run", binPath], available: true };
	}
	return {
		command: "bun",
		args: ["run", binPath],
		available: false,
	};
}

export const createBrowserAutomationRouter = () => {
	return router({
		getMcpStatus: publicProcedure.query(() => {
			// Claude readiness is resolved in two dimensions so a single
			// configured project never makes sessions from other projects
			// look ready:
			//   - `claudeHomeReady`: only the top-level (user-scope)
			//     mcpServers in $HOME files.
			//   - `claudeReadyByWorkspaceId`: for each workspace, check
			//     * `~/.claude.json` under `projects[<workspace path>]`
			//       (local scope, where `claude mcp add` lands by default)
			//     * `<workspace>/.mcp.json` (project scope)
			// Only accept entries that point at *this* install's bundled
			// binary. An older desktop-mcp / legacy superset-browser-mcp
			// registration from a prior build would otherwise be reported
			// as ready and the UI would enable Connect against a command
			// that does not exist.
			const expected = resolveSupersetBrowserMcpCommand();
			const claudeHomeReady = detectClaudeMcp(CLAUDE_CONFIG_PATHS, {
				expected,
			});
			const wsInfo = collectWorkspacePathsByWorkspaceId();
			const claudeReadyByWorkspaceId: Record<string, boolean> = {};
			for (const [workspaceId, info] of Object.entries(wsInfo)) {
				const localScope = detectClaudeMcpInFile(CLAUDE_USER_JSON_PATH, {
					workspacePaths: [info.base],
					expected,
				});
				const projectScope = detectClaudeMcpInFile(info.mcpJsonPath, {
					expected,
				});
				claudeReadyByWorkspaceId[workspaceId] = localScope || projectScope;
			}
			const codexReady = detectCodexMcp(CODEX_CONFIG_PATH, expected);
			return {
				claudeHomeReady,
				claudeReadyByWorkspaceId,
				codexReady,
				claudeConfigPath: CLAUDE_USER_JSON_PATH,
				codexConfigPath: CODEX_CONFIG_PATH,
				serverCommand: expected,
			};
		}),

		listTerminalAgentSessions: publicProcedure.query(() =>
			detectTerminalAgentSessions(),
		),

		listBindings: publicProcedure.query(() => bindingStore.list()),

		/**
		 * Cheap resolver used by the per-pane `ConnectButton` to decide
		 * whether a stored binding still maps to a live worker. Runs once
		 * per window (React Query dedupes the call) so many Connect buttons
		 * cost one main-process query total. Terminal bindings are resolved
		 * by scanning the PTY process tree; TODO-Agent bindings by matching
		 * against the live status whitelist.
		 */
		listBindingLiveness: publicProcedure.query(async () => {
			// Sweep out any persisted todo-agent bindings — those were
			// allowed by an earlier build but the MCP bridge cannot resolve
			// them yet. Leaving them would show up as "Connected" on the
			// ConnectButton even though no session is reachable. After the
			// sweep, re-read.
			const stored = bindingStore.list();
			for (const b of stored) {
				if (b.sessionKind === "todo-agent") {
					bindingStore.remove(b.paneId);
				}
			}
			const bindings = bindingStore.list();
			if (bindings.length === 0)
				return [] as Array<{
					paneId: string;
					sessionId: string;
					sessionKind: string;
					live: boolean;
				}>;
			const hasTerminalBinding = bindings.some(
				(b) => b.sessionKind === "terminal",
			);
			// Only probe the terminal daemon when at least one binding actually
			// points at a terminal — otherwise every Connect button's 15s poll
			// would wake the terminal-host and walk every PTY's process tree.
			const liveTerminalIds = hasTerminalBinding
				? new Set(
						(await detectTerminalAgentSessions()).map(
							(t) => `terminal:${t.paneId}`,
						),
					)
				: new Set<string>();
			return bindings.map((b) => {
				const live =
					b.sessionKind === "terminal"
						? liveTerminalIds.has(b.sessionId)
						: false;
				return {
					paneId: b.paneId,
					sessionId: b.sessionId,
					sessionKind: b.sessionKind,
					live,
				};
			});
		}),

		getBindingByPane: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => bindingStore.get(input.paneId)),

		getBindingBySession: publicProcedure
			.input(z.object({ sessionId: z.string() }))
			.query(({ input }) => bindingStore.getBySessionId(input.sessionId)),

		setBinding: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					sessionId: z.string(),
					sessionKind: z.enum(["todo-agent", "terminal"]).default("terminal"),
				}),
			)
			.mutation(({ input }) => {
				// TODO-Agent workers live in the todo-daemon process; the
				// browser-mcp bridge in main can't resolve their PIDs yet.
				// Reject the binding instead of letting users create one
				// whose MCP tool calls would always error.
				if (input.sessionKind === "todo-agent") {
					throw new Error(
						"TODO-Agent browser automation bindings are not supported yet. Run claude / codex in a Superset terminal pane instead.",
					);
				}
				return bindingStore.set(
					input.paneId,
					input.sessionId,
					input.sessionKind,
				);
			}),

		removeBinding: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => ({
				removed: bindingStore.remove(input.paneId),
			})),

		getMcpInstallState: publicProcedure.query(async () => {
			const { getInstallState } = await import(
				"main/lib/browser-mcp-bridge/mcp-installer"
			);
			return getInstallState(resolveSupersetBrowserMcpCommand());
		}),

		installMcp: publicProcedure
			.input(
				z.object({
					targets: z.array(z.enum(["claude", "codex"])).min(1),
				}),
			)
			.mutation(async ({ input }) => {
				const server = resolveSupersetBrowserMcpCommand();
				if (!server.available) {
					throw new Error(
						"The bundled superset-browser-mcp binary is not available in this build.",
					);
				}
				const { installMcp } = await import(
					"main/lib/browser-mcp-bridge/mcp-installer"
				);
				return installMcp(input.targets, server);
			}),

		/**
		 * Resolve the per-session filtered CDP endpoint directly from the
		 * UI (no MCP round-trip). Used by the Connect dialog to show a
		 * copy-ready URL and example commands for external browser MCPs.
		 */
		getCdpEndpointForSession: publicProcedure
			.input(z.object({ sessionId: z.string() }))
			.query(async ({ input }) => {
				const binding = bindingStore.getBySessionId(input.sessionId);
				if (!binding) {
					return { available: false as const, reason: "not-bound" as const };
				}
				const { browserManager } = await import(
					"main/lib/browser/browser-manager"
				);
				const targetId = browserManager.getCdpTargetId(binding.paneId);
				if (!targetId) {
					return {
						available: false as const,
						reason: "target-not-ready" as const,
					};
				}
				const { resolveCdpPort } = await import(
					"main/lib/browser-mcp-bridge/cdp-port"
				);
				const cdpPort = await resolveCdpPort();
				if (!cdpPort) {
					return {
						available: false as const,
						reason: "cdp-disabled" as const,
					};
				}
				const { getBrowserMcpBridge } = await import(
					"main/lib/browser-mcp-bridge/server"
				);
				const { getGlobalBrowserUseConfigPath } = await import(
					"main/lib/browser-mcp-bridge/cdp-gateway"
				);
				const bridge = getBrowserMcpBridge();
				if (!bridge) {
					return {
						available: false as const,
						reason: "bridge-not-running" as const,
					};
				}
				// The URL is the same for every LLM session; per-connection
				// peer-PID resolution is how the gateway knows which pane
				// to route to. That is why registering these MCPs once is
				// enough even across Superset restarts, pane rebindings,
				// and new terminal panes.
				return {
					available: true as const,
					paneId: binding.paneId,
					targetId,
					httpBase: `http://127.0.0.1:${bridge.port}`,
					wsEndpoint: `ws://127.0.0.1:${bridge.port}/devtools/page/${targetId}`,
					browserUseConfigPath: getGlobalBrowserUseConfigPath(),
				};
			}),

		onBindingsChanged: publicProcedure.subscription(() => {
			return observable<BrowserAutomationBinding[]>((emit) => {
				emit.next(bindingStore.list());
				const off = bindingStore.onChange((list) => emit.next(list));
				return () => {
					off();
				};
			});
		}),
	});
};
