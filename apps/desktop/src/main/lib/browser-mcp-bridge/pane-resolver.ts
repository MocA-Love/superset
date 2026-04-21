import {
	getProcessCommand,
	getProcessName,
	getProcessTree,
} from "main/lib/terminal/port-scanner";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";

/**
 * PID-based automatic mapping from an MCP process's PPID (the Claude /
 * Codex CLI that spawned the MCP) to a Superset session and therefore
 * a bound browser pane.
 *
 * Resolution today walks every live terminal pane's PTY process tree
 * for the PPID. TODO-Agent worker resolution will be added in a
 * follow-up that pipes the worker PID through the daemon-bridge IPC
 * (the daemon is a separate process, so an in-process registry cannot
 * reach this main-process code).
 *
 * Positive resolutions are cached briefly so we do not re-walk process
 * trees on every tool call. Negative resolutions are NOT cached — a
 * miss can be a transient listSessions failure or a brief race.
 */
export interface ResolvedSession {
	sessionId: string;
	kind: "todo-agent" | "terminal";
	paneId?: string;
}

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
	resolved: ResolvedSession;
	at: number;
}

const cache = new Map<number, CacheEntry>();

async function resolveFromTerminalPanes(
	ppid: number,
): Promise<ResolvedSession | null> {
	let sessions: Awaited<
		ReturnType<ReturnType<typeof getTerminalHostClient>["listSessions"]>
	>["sessions"];
	try {
		const client = getTerminalHostClient();
		const res = await client.listSessions();
		sessions = res.sessions;
	} catch {
		return null;
	}
	for (const s of sessions) {
		if (!s.isAlive || typeof s.pid !== "number") continue;
		// A single pane's process tree / name lookup can race with
		// exit; swallow the per-pane failure and try the next one.
		try {
			const tree = await getProcessTree(s.pid);
			if (!tree.includes(ppid)) continue;
			// Accept the pane if our parent looks like claude / codex
			// (either directly, or as a node-wrapped CLI we can spot by
			// argv). comm alone is not enough because node CLIs commonly
			// appear as comm=node with the real entrypoint in argv.
			const [name, command] = await Promise.all([
				getProcessName(ppid).catch(() => ""),
				getProcessCommand(ppid).catch(() => ""),
			]);
			const lname = name.toLowerCase();
			const looksAgent =
				lname === "claude" ||
				lname === "codex" ||
				/\b(claude|codex)(?:\.js)?\b/.test(command);
			if (looksAgent || lname.includes("node")) {
				return {
					sessionId: `terminal:${s.paneId}`,
					kind: "terminal",
					paneId: s.paneId,
				};
			}
		} catch {
			// Keep scanning — other panes may still match.
		}
	}
	return null;
}

export async function resolvePpidToSession(
	ppid: number,
): Promise<ResolvedSession | null> {
	const cached = cache.get(ppid);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return cached.resolved;
	}
	const resolved = await resolveFromTerminalPanes(ppid);
	if (resolved) cache.set(ppid, { resolved, at: Date.now() });
	return resolved;
}

/**
 * Like resolvePpidToSession but walks by process-tree *inclusion*
 * rather than by PPID identity, and skips the claude/codex name check.
 *
 * Use this when the caller holds the PID of an arbitrary descendant of
 * a Superset terminal pane (e.g. a loopback peer PID obtained from
 * lsof). The MCP's immediate parent is often `npx`, `uvx`, or a node
 * wrapper rather than Claude / Codex itself, so the
 * looksAgent heuristic would reject the caller. The descendant has
 * to have been launched from inside a Superset terminal pane anyway —
 * that is itself the security boundary, and tree-inclusion is
 * sufficient evidence of that.
 */
export async function resolvePidToSession(
	pid: number,
): Promise<ResolvedSession | null> {
	if (!Number.isFinite(pid) || pid <= 0) return null;
	const cached = cache.get(pid);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return cached.resolved;
	}
	let sessions: Awaited<
		ReturnType<ReturnType<typeof getTerminalHostClient>["listSessions"]>
	>["sessions"];
	try {
		const client = getTerminalHostClient();
		const res = await client.listSessions();
		sessions = res.sessions;
	} catch {
		return null;
	}
	for (const s of sessions) {
		if (!s.isAlive || typeof s.pid !== "number") continue;
		try {
			const tree = await getProcessTree(s.pid);
			if (!tree.includes(pid)) continue;
			const resolved: ResolvedSession = {
				sessionId: `terminal:${s.paneId}`,
				kind: "terminal",
				paneId: s.paneId,
			};
			cache.set(pid, { resolved, at: Date.now() });
			return resolved;
		} catch {
			// Next pane.
		}
	}
	return null;
}

export function getBoundPaneForSession(sessionId: string): string | null {
	const binding = bindingStore.getBySessionId(sessionId);
	return binding?.paneId ?? null;
}
