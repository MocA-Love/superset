import { settings } from "@superset/local-db";
import { powerSaveBlocker } from "electron";
import { localDb } from "main/lib/local-db";
import { DEFAULT_PREVENT_AGENT_SLEEP, PLATFORM } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";

/**
 * Windows sleep-prevention, driven by agent lifecycle events.
 *
 * macOS and Linux run a bash-embedded `caffeinate` / `systemd-inhibit` inside
 * each agent wrapper so inhibition follows the wrapper process lifetime. On
 * Windows we don't ship wrappers (no bash runtime, PowerShell profile injection
 * is a follow-up), so we centralise inhibit tracking in the main process via
 * Electron's `powerSaveBlocker`.
 *
 * An entry is added to `active` when an agent transitions into Start or
 * PermissionRequest, and removed on Stop or on terminal exit. While at least
 * one entry is present, a single `prevent-app-suspension` blocker is held;
 * `prevent-display-sleep` is intentionally avoided — it keeps the monitor on,
 * which is a user-hostile default for "don't sleep while agents are running."
 */

const active = new Set<string>();
let blockerId: number | null = null;

function preventSleepSettingEnabled(): boolean {
	try {
		return (
			localDb.select().from(settings).get()?.preventAgentSleep ??
			DEFAULT_PREVENT_AGENT_SLEEP
		);
	} catch {
		return DEFAULT_PREVENT_AGENT_SLEEP;
	}
}

function buildKey(event: AgentLifecycleEvent): string {
	return `${event.workspaceId ?? "-"}:${event.tabId ?? "-"}:${event.paneId ?? "-"}`;
}

function ensureBlocker(): void {
	if (blockerId !== null) return;
	try {
		blockerId = powerSaveBlocker.start("prevent-app-suspension");
	} catch (error) {
		console.warn(
			"[windows-sleep-blocker] Failed to start powerSaveBlocker:",
			error,
		);
	}
}

function releaseBlocker(): void {
	if (blockerId === null) return;
	try {
		powerSaveBlocker.stop(blockerId);
	} catch (error) {
		console.warn(
			"[windows-sleep-blocker] Failed to stop powerSaveBlocker:",
			error,
		);
	}
	blockerId = null;
}

export function handleAgentLifecycleForWindowsSleep(
	event: AgentLifecycleEvent,
): void {
	if (!PLATFORM.IS_WINDOWS) return;
	if (!preventSleepSettingEnabled()) {
		// Setting was toggled off mid-flight — drop any inhibitor we were holding.
		if (blockerId !== null) {
			active.clear();
			releaseBlocker();
		}
		return;
	}

	const key = buildKey(event);
	switch (event.eventType) {
		case "Start":
		case "PermissionRequest":
			active.add(key);
			ensureBlocker();
			break;
		case "Stop":
			active.delete(key);
			if (active.size === 0) releaseBlocker();
			break;
		default:
			break;
	}
}

export function handleTerminalExitForWindowsSleep(paneId: string): void {
	if (!PLATFORM.IS_WINDOWS) return;
	// Drop every tracked entry belonging to this pane; a terminal exit
	// always means no more agent work will come from that pane.
	const suffix = `:${paneId}`;
	for (const key of Array.from(active)) {
		if (key.endsWith(suffix)) active.delete(key);
	}
	if (active.size === 0) releaseBlocker();
}
