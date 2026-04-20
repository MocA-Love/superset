import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	browserAutomationBindings,
	projects,
	type SelectBrowserAutomationBinding,
	workspaces,
	worktrees,
} from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import { and, eq, ne } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { getProcessName, getProcessTree } from "main/lib/terminal/port-scanner";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import { getTodoSessionStore } from "main/todo-agent/session-store";
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

function isEnabledMcpEntry(value: unknown): boolean {
	if (value == null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	if (entry.disabled === true) return false;
	// An entry needs at minimum a command/url/args hint to be usable.
	return (
		typeof entry.command === "string" ||
		typeof entry.url === "string" ||
		Array.isArray(entry.args)
	);
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
function detectClaudeMcpInFile(filePath: string): boolean {
	try {
		const contents = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(contents) as unknown;
		if (!parsed || typeof parsed !== "object") return false;
		const mcp = (parsed as Record<string, unknown>).mcpServers;
		if (!mcp || typeof mcp !== "object") return false;
		return isEnabledMcpEntry((mcp as Record<string, unknown>)[SERVER_NAME]);
	} catch {
		return false;
	}
}

function detectClaudeMcp(paths: readonly string[]): boolean {
	return paths.some(detectClaudeMcpInFile);
}

/**
 * Resolve the `.mcp.json` path for each workspace keyed by workspaceId,
 * so per-project MCP definitions (output of `claude mcp add -s project`)
 * can be considered per-session without letting one configured project
 * make sessions from other projects look ready.
 */
function collectProjectMcpJsonPathsByWorkspace(): Record<string, string> {
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
		const out: Record<string, string> = {};
		for (const row of rows) {
			const base = row.worktreePath ?? row.mainRepoPath ?? null;
			if (row.workspaceId && base) {
				out[row.workspaceId] = join(base, ".mcp.json");
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
function detectCodexMcp(filePath: string): boolean {
	try {
		const contents = readFileSync(filePath, "utf8");
		// TOML accepts several equivalent header forms for the same table:
		//   [mcp_servers.superset-browser]
		//   [mcp_servers."superset-browser"]
		//   [mcp_servers.'superset-browser']
		//   ["mcp_servers".superset-browser]   (rarely used)
		// The regex below matches the common shapes; it is not a full TOML
		// parser but is strict enough that typos and unrelated keys don't
		// match.
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
		return body.some((line) => /^(command|url|args)\s*=/.test(line));
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
			// Skip the shell itself (root pid) when matching names so typing
			// `claude` at the prompt inside zsh does not cause the shell's
			// argv to trigger a match.
			const names = await Promise.all(
				pids
					.filter((p) => p !== s.pid)
					.map(async (p) => ({ pid: p, name: await getProcessName(p) })),
			);
			const match = names.find(
				({ name }) => name === "claude" || name === "codex",
			);
			if (!match) return;
			out.push({
				paneId: s.paneId,
				workspaceId: s.workspaceId,
				pid: match.pid,
				provider: match.name === "codex" ? "Codex" : "Claude",
				command: match.name,
				lastAttachedAt: s.lastAttachedAt,
			});
		}),
	);
	return out;
}

export const createBrowserAutomationRouter = () => {
	return router({
		getMcpStatus: publicProcedure.query(() => {
			// Claude readiness is resolved in two dimensions:
			//   - `claudeHomeReady`: user/legacy files in $HOME.
			//   - `claudeReadyByWorkspaceId`: per-workspace `.mcp.json` probe
			//     (keyed by workspaceId) so a single configured project does
			//     not make sessions from other projects look ready.
			// A session is ready when its home check OR its workspace probe
			// finds the entry; callers combine the two by workspaceId.
			const claudeHomeReady = detectClaudeMcp(CLAUDE_CONFIG_PATHS);
			const projectPaths = collectProjectMcpJsonPathsByWorkspace();
			const claudeReadyByWorkspaceId: Record<string, boolean> = {};
			for (const [workspaceId, path] of Object.entries(projectPaths)) {
				claudeReadyByWorkspaceId[workspaceId] = detectClaudeMcpInFile(path);
			}
			const codexReady = detectCodexMcp(CODEX_CONFIG_PATH);
			return {
				claudeHomeReady,
				claudeReadyByWorkspaceId,
				codexReady,
				claudeConfigPath: CLAUDE_USER_JSON_PATH,
				codexConfigPath: CODEX_CONFIG_PATH,
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
			const hasTodoBinding = bindings.some((b) => b.sessionKind !== "terminal");
			const liveTodoIds = hasTodoBinding
				? new Set(
						getTodoSessionStore()
							.listAll()
							.filter((s) =>
								["running", "preparing", "verifying", "waiting"].includes(
									s.status,
								),
							)
							.map((s) => s.id),
					)
				: new Set<string>();
			// Only probe the terminal daemon when at least one binding actually
			// points at a terminal — otherwise every Connect button's 15s poll
			// would wake the terminal-host and walk every PTY's process tree
			// just to confirm TODO-Agent liveness we already have in memory.
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
						: liveTodoIds.has(b.sessionId);
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
					sessionKind: z.enum(["todo-agent", "terminal"]).default("todo-agent"),
				}),
			)
			.mutation(({ input }) =>
				bindingStore.set(input.paneId, input.sessionId, input.sessionKind),
			),

		removeBinding: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => ({
				removed: bindingStore.remove(input.paneId),
			})),

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
