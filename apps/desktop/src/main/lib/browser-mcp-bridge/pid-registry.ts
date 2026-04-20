/**
 * In-memory registry of { pid: string -> todoSessionId }. The todo-agent
 * supervisor reports each Claude worker it spawns here so the browser-mcp
 * bridge can resolve `process.ppid` -> running session in one lookup,
 * without having to walk every terminal's PTY tree for todo-agent cases.
 *
 * Entries are cleared on process exit.
 */
const byPid = new Map<number, string>();

export function registerTodoAgentWorker(sessionId: string, pid: number): void {
	byPid.set(pid, sessionId);
}

export function unregisterTodoAgentWorker(pid: number): void {
	byPid.delete(pid);
}

export function findTodoAgentSessionByPid(pid: number): string | null {
	return byPid.get(pid) ?? null;
}

export function listTodoAgentWorkers(): Array<{
	pid: number;
	sessionId: string;
}> {
	return Array.from(byPid.entries()).map(([pid, sessionId]) => ({
		pid,
		sessionId,
	}));
}
