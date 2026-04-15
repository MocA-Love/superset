/**
 * One-time migration from the old hotkey storage (main process JSON file via tRPC)
 * to the new localStorage-based Zustand store.
 *
 * Marker key is bumped (`-v2`) so users who migrated on the pre-sanitizer
 * build re-run once and get their corrupt entries dropped.
 */

import { electronTrpcClient } from "renderer/lib/trpc-client";
import { PLATFORM } from "./registry";
import { isUSCompatibleLayout } from "./utils/detectUSLayout";
import { sanitizeOverride } from "./utils/sanitizeOverride";

const MIGRATION_MARKER_KEY = "hotkey-overrides-migrated-v2";

const PLATFORM_MAP = {
	mac: "darwin",
	windows: "win32",
	linux: "linux",
} as const;

function sanitizeOverridesMap(
	raw: Record<string, string | null>,
	assumeUSMacLayout: boolean,
): { cleaned: Record<string, string | null>; dropped: number } {
	const cleaned: Record<string, string | null> = {};
	let dropped = 0;
	for (const [id, value] of Object.entries(raw)) {
		const sanitized = sanitizeOverride(value, { assumeUSMacLayout });
		if (sanitized === undefined) {
			dropped++;
			continue;
		}
		cleaned[id] = sanitized;
	}
	return { cleaned, dropped };
}

export async function migrateHotkeyOverrides(): Promise<void> {
	if (localStorage.getItem(MIGRATION_MARKER_KEY)) return;

	try {
		const assumeUSMacLayout =
			PLATFORM === "mac" ? await isUSCompatibleLayout() : true;

		// FORK NOTE: If the user already has a hotkey-overrides entry in
		// localStorage from an earlier migration, don't overwrite it with the
		// potentially stale legacy tRPC store value — but still re-run the
		// sanitizer over those entries. The -v2 marker bump specifically exists
		// so users whose pre-sanitizer localStorage contains corrupt overrides
		// get them re-sanitized (or dropped) once.
		const existingRaw = localStorage.getItem("hotkey-overrides");
		if (existingRaw) {
			try {
				const parsed = JSON.parse(existingRaw) as {
					state?: { overrides?: Record<string, string | null> };
				};
				const overrides = parsed?.state?.overrides;
				if (overrides && Object.keys(overrides).length > 0) {
					const { cleaned, dropped } = sanitizeOverridesMap(
						overrides,
						assumeUSMacLayout,
					);
					localStorage.setItem(
						"hotkey-overrides",
						JSON.stringify({ state: { overrides: cleaned }, version: 0 }),
					);
					console.log(
						`[hotkeys] Re-sanitized ${Object.keys(cleaned).length} localStorage override(s)` +
							(dropped > 0 ? `, dropped ${dropped} invalid` : ""),
					);
				} else {
					console.log(
						"[hotkeys] Migration skipped — localStorage overrides empty",
					);
				}
			} catch (parseError) {
				console.log(
					"[hotkeys] Failed to parse existing localStorage overrides, leaving untouched:",
					parseError,
				);
			}
			localStorage.setItem(MIGRATION_MARKER_KEY, "1");
			return;
		}

		const oldState = await electronTrpcClient.uiState.hotkeys.get.query();
		const oldPlatformKey = PLATFORM_MAP[PLATFORM];
		const oldOverrides = oldState?.byPlatform?.[oldPlatformKey];
		if (!oldOverrides || Object.keys(oldOverrides).length === 0) {
			localStorage.setItem(MIGRATION_MARKER_KEY, "1");
			console.log("[hotkeys] Migration skipped — no old overrides found");
			return;
		}

		const { cleaned, dropped } = sanitizeOverridesMap(
			oldOverrides,
			assumeUSMacLayout,
		);

		localStorage.setItem(
			"hotkey-overrides",
			JSON.stringify({ state: { overrides: cleaned }, version: 0 }),
		);
		localStorage.setItem(MIGRATION_MARKER_KEY, "1");
		console.log(
			`[hotkeys] Migrated ${Object.keys(cleaned).length} override(s)` +
				(dropped > 0 ? `, dropped ${dropped} invalid` : ""),
		);
	} catch (error) {
		// Marker intentionally not set — transient tRPC failures retry next boot.
		console.log("[hotkeys] Migration failed, will retry next boot:", error);
	}
}
