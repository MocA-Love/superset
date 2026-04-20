import { getProcessName, getProcessTree } from "main/lib/terminal/port-scanner";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import { bindingStore } from "../../../lib/trpc/routers/browser-automation/index";
import { findTodoAgentSessionByPid } from "./pid-registry";

/**
 * PID-based automatic mapping from an MCP process's PPID (the Claude /
 * Codex CLI that spawned the MCP) to a Superset session and therefore a
 * bound browser pane.
 *
 * Resolution order:
 *   1. A todo-agent worker PID registered with this exact PID.
 *   2. A terminal pane whose PTY process tree contains this PID.
 *
 * The first match wins. The mapping is cached briefly so we do not re-walk
 * every terminal's /proc tree on every MCP tool call.
 */
export interface ResolvedSession {
	sessionId: string;
	kind: "todo-agent" | "terminal";
	paneId?: string;
}

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
	resolved: ResolvedSession | null;
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
		const tree = await getProcessTree(s.pid);
		if (tree.includes(ppid)) {
			// Validate the PPID actually looks like an agent so we don't
			// snap random terminal children into sessions.
			const name = await getProcessName(ppid).catch(() => "");
			if (name === "claude" || name === "codex" || name.includes("node")) {
				return {
					sessionId: `terminal:${s.paneId}`,
					kind: "terminal",
					paneId: s.paneId,
				};
			}
		}
	}
	return null;
}

function resolveFromTodoAgent(ppid: number): ResolvedSession | null {
	const sessionId = findTodoAgentSessionByPid(ppid);
	if (sessionId) {
		return { sessionId, kind: "todo-agent" };
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
	const todo = resolveFromTodoAgent(ppid);
	const resolved = todo ?? (await resolveFromTerminalPanes(ppid));
	cache.set(ppid, { resolved, at: Date.now() });
	return resolved;
}

export function getBoundPaneForSession(sessionId: string): string | null {
	const binding = bindingStore.getBySessionId(sessionId);
	return binding?.paneId ?? null;
}
