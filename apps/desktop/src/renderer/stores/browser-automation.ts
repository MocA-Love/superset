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

interface BrowserAutomationState {
	sessions: Record<string, AutomationSession>;
	/** paneId -> sessionId */
	bindings: Record<string, string>;
	connectModal: {
		isOpen: boolean;
		paneId: string | null;
		selectedSessionId: string | null;
	};
	listViewOpen: boolean;
	openConnectModal: (paneId: string, preselectSessionId?: string) => void;
	closeConnectModal: () => void;
	setSelectedSession: (sessionId: string) => void;
	connect: (
		paneId: string,
		sessionId: string,
	) => { reassignedFromPaneId: string | null };
	disconnect: (paneId: string) => void;
	markSessionReady: (sessionId: string) => void;
	setListViewOpen: (open: boolean) => void;
}

const initialSessions: Record<string, AutomationSession> = {
	"session-14": {
		id: "session-14",
		displayName: "Session 14",
		provider: "Codex",
		kind: "Terminal",
		branchOrContextLabel: "feature/browser-cdp-map",
		lastActiveAt: "20s ago",
		mcpStatus: "ready",
	},
	"session-11": {
		id: "session-11",
		displayName: "Session 11",
		provider: "Claude",
		kind: "Terminal",
		branchOrContextLabel: "checkout-debug",
		lastActiveAt: "2m ago",
		mcpStatus: "missing",
	},
	"session-09": {
		id: "session-09",
		displayName: "Session 09",
		provider: "Codex",
		kind: "Chat",
		branchOrContextLabel: "release-notes-draft",
		lastActiveAt: "6m ago",
		mcpStatus: "ready",
	},
};

export const useBrowserAutomationStore = create<BrowserAutomationState>(
	(set, get) => ({
		sessions: initialSessions,
		bindings: {},
		connectModal: { isOpen: false, paneId: null, selectedSessionId: null },
		listViewOpen: false,
		openConnectModal: (paneId, preselectSessionId) => {
			const state = get();
			const currentBinding = state.bindings[paneId];
			const fallback = Object.keys(state.sessions)[0] ?? null;
			set({
				connectModal: {
					isOpen: true,
					paneId,
					selectedSessionId: preselectSessionId ?? currentBinding ?? fallback,
				},
			});
		},
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
		connect: (paneId, sessionId) => {
			const state = get();
			const reassignedFromPaneId =
				Object.entries(state.bindings).find(
					([pid, sid]) => sid === sessionId && pid !== paneId,
				)?.[0] ?? null;
			const next: Record<string, string> = { ...state.bindings };
			if (reassignedFromPaneId) delete next[reassignedFromPaneId];
			next[paneId] = sessionId;
			set({ bindings: next });
			return { reassignedFromPaneId };
		},
		disconnect: (paneId) =>
			set((s) => {
				const next = { ...s.bindings };
				delete next[paneId];
				return { bindings: next };
			}),
		markSessionReady: (sessionId) =>
			set((s) => ({
				sessions: {
					...s.sessions,
					[sessionId]: { ...s.sessions[sessionId], mcpStatus: "ready" },
				},
			})),
		setListViewOpen: (open) => set({ listViewOpen: open }),
	}),
);

export function getSnippetForSession(session: AutomationSession): string {
	if (session.provider === "Codex") {
		return `[mcp_servers.superset-browser]
command = "superset-browser-mcp"
args = []`;
	}
	return `{
  "mcpServers": {
    "superset-browser": {
      "command": "superset-browser-mcp"
    }
  }
}`;
}
