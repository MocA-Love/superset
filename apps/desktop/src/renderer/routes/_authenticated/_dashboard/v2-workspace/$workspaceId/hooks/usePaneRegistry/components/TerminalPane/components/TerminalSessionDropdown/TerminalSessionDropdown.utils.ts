export const TERMINAL_SESSION_LIST_REFETCH_INTERVAL_MS = 2_000;
export const TERMINAL_SESSION_LIST_STALE_MS = 5_000;

export function shouldQueryTerminalSessionList(isOpen: boolean): boolean {
	return isOpen;
}

export function getTerminalSessionListRefetchInterval(
	isOpen: boolean,
): number | false {
	return isOpen ? TERMINAL_SESSION_LIST_REFETCH_INTERVAL_MS : false;
}

export function getTerminalDisplayTitle({
	titleOverride,
	runtimeTitle,
	sessionTitle,
}: {
	titleOverride?: string;
	runtimeTitle?: string | null;
	sessionTitle?: string | null;
}): string {
	// Explicit pane titles come from user/preset labels, so transient shell
	// titles like "zsh" should not hide them.
	return titleOverride ?? runtimeTitle ?? sessionTitle ?? "Terminal";
}
