import type { WorkspaceState } from "@superset/panes";
import type { TerminalPaneData } from "../../types";

export const BACKGROUND_TERMINAL_ATTACHMENT_DEBOUNCE_MS = 250;
export const BACKGROUND_TERMINAL_COUNT_REFETCH_INTERVAL_MS = 10_000;
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

export function getAttachedTerminalIdsKey(
	tabs: WorkspaceState<unknown>["tabs"],
): string {
	return JSON.stringify(getAttachedTerminalIds(tabs));
}

export function parseAttachedTerminalIdsKey(key: string): string[] {
	try {
		const parsed = JSON.parse(key);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

export function getBackgroundTerminalSessions<
	TSession extends TerminalSessionSummary,
>(sessions: TSession[], attachedTerminalIds: Iterable<string>): TSession[] {
	const attachedIds = new Set(attachedTerminalIds);
	return sessions
		.filter((session) => !attachedIds.has(session.terminalId))
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function getUnattachedTerminalIds(
	terminalIds: Iterable<string>,
	attachedTerminalIds: Iterable<string>,
): string[] {
	const attachedIds = new Set(attachedTerminalIds);
	return [...new Set(terminalIds)]
		.filter((terminalId) => !attachedIds.has(terminalId))
		.sort();
}

export function getBackgroundTerminalCountRefetchInterval(
	isOpen: boolean,
): number | false {
	return isOpen ? false : BACKGROUND_TERMINAL_COUNT_REFETCH_INTERVAL_MS;
}

export function getBackgroundTerminalListRefetchInterval(
	isOpen: boolean,
): number | false {
	return isOpen ? BACKGROUND_TERMINAL_LIST_REFETCH_INTERVAL_MS : false;
}
