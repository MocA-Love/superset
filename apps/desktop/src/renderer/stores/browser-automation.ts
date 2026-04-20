import { create } from "zustand";

export type McpStatus = "ready" | "missing" | "unknown";

export interface AutomationSession {
	id: string;
	displayName: string;
	provider: "Claude" | "Codex" | string;
	kind: "Terminal" | "Chat" | string;
	branchOrContextLabel: string;
	lastActiveAt: string;
	mcpStatus: McpStatus;
}

/**
 * UI-only state for the browser-automation feature.
 *
 * Real data (sessions, bindings, MCP status) lives in main-process tRPC
 * routers and is consumed via `useBrowserAutomationData`. This store
 * only tracks transient UI state that does not need to survive reloads
 * or sync with the main process:
 *   - Which pane opened the Connect dialog, and which session is
 *     currently highlighted within it.
 *   - Whether the cross-pane list view dialog is open.
 */
interface BrowserAutomationUiState {
	connectModal: {
		isOpen: boolean;
		paneId: string | null;
		selectedSessionId: string | null;
	};
	listViewOpen: boolean;
	openConnectModal: (paneId: string, preselectSessionId?: string) => void;
	closeConnectModal: () => void;
	setSelectedSession: (sessionId: string | null) => void;
	setListViewOpen: (open: boolean) => void;
}

export const useBrowserAutomationStore = create<BrowserAutomationUiState>(
	(set) => ({
		connectModal: { isOpen: false, paneId: null, selectedSessionId: null },
		listViewOpen: false,
		openConnectModal: (paneId, preselectSessionId) =>
			set({
				connectModal: {
					isOpen: true,
					paneId,
					selectedSessionId: preselectSessionId ?? null,
				},
			}),
		closeConnectModal: () =>
			set({
				connectModal: {
					isOpen: false,
					paneId: null,
					selectedSessionId: null,
				},
			}),
		setSelectedSession: (sessionId) =>
			set((s) => ({
				connectModal: { ...s.connectModal, selectedSessionId: sessionId },
			})),
		setListViewOpen: (open) => set({ listViewOpen: open }),
	}),
);

export interface ServerCommand {
	command: string;
	args: string[];
	available: boolean;
}

function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
	return /^[\w@./:+-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, "'\\''")}'`;
}

export function getSnippetForSession(
	session: AutomationSession,
	server?: ServerCommand,
): string {
	const cmd = server?.command ?? "desktop-mcp";
	const args = server?.args ?? [];
	if (session.provider === "Codex") {
		const argsToml = args.map(tomlString).join(", ");
		return `[mcp_servers.superset-browser]
command = ${tomlString(cmd)}
args = [${argsToml}]`;
	}
	const parts = [cmd, ...args].map(shellQuote).join(" ");
	return `claude mcp add superset-browser -s local -- ${parts}`;
}

function formatRelativeTime(ts: number | null | undefined): string {
	if (!ts) return "unknown";
	const diffSec = Math.round((Date.now() - ts) / 1000);
	if (diffSec < 5) return "just now";
	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.round(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHour = Math.round(diffMin / 60);
	if (diffHour < 24) return `${diffHour}h ago`;
	const diffDay = Math.round(diffHour / 24);
	return `${diffDay}d ago`;
}

export { formatRelativeTime };
