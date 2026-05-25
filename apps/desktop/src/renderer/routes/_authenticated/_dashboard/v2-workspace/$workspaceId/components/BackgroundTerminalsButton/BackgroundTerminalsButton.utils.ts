import type { WorkspaceState } from "@superset/panes";
import type { TerminalPaneData } from "../../types";

export const BACKGROUND_TERMINAL_COUNT_REFETCH_INTERVAL_MS = 30_000;
export const BACKGROUND_TERMINAL_LIST_REFETCH_INTERVAL_MS = 2_000;

export interface TerminalSessionSummary {
	terminalId: string;
	createdAt?: number;
	title: string | null;
}

export function getAttachedTerminalIds(
	tabs: WorkspaceState<unknown>["tabs"],
): string[] {
	const ids = new Set<string>();
	for (const tab of tabs) {
		for (const pane of Object.values(tab.panes)) {
			if (pane.kind !== "terminal") continue;
			const data = pane.data as Partial<TerminalPaneData>;
			if (data.terminalId) ids.add(data.terminalId);
		}
	}
	return [...ids].sort();
}

export function getBackgroundTerminalSessions<
	TSession extends TerminalSessionSummary,
>(sessions: TSession[], attachedTerminalIds: Iterable<string>): TSession[] {
	const attachedIds = new Set(attachedTerminalIds);
	return sessions
		.filter((session) => !attachedIds.has(session.terminalId))
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
