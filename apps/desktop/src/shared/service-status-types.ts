// Statuspage.io `/api/v2/status.json` indicator values.
// See https://doers.statuspage.io/api/v2/pages/#status
export type StatuspageIndicator =
	| "none"
	| "minor"
	| "major"
	| "critical"
	| "maintenance";

export type ServiceStatusLevel =
	| "operational"
	| "minor"
	| "major"
	| "critical"
	| "unknown";

// Previously a closed union of "claude" | "codex". Definitions are now
// user-configurable and stored in local-db, so ids are arbitrary strings
// (UUIDs for user-added rows; stable slugs for the default Claude/Codex
// entries that get seeded on first launch).
export type ServiceStatusId = string;

// Mirrors `ServiceStatusIconType` from `@superset/local-db` without importing
// it into shared/ (which main, renderer, and preload all consume). Keep both
// in sync manually.
export type ServiceStatusIconType =
	| "simple-icon"
	| "favicon"
	| "custom-url"
	| "custom-file";

export interface ServiceStatusDefinition {
	id: ServiceStatusId;
	label: string;
	statusUrl: string;
	apiUrl: string;
	iconType: ServiceStatusIconType;
	// simple-icon: slug (e.g. "claude"); custom-url: remote URL; custom-file:
	// absolute path under userData; favicon: ignored (null).
	iconValue: string | null;
	sortOrder: number;
}

export interface ServiceStatusSnapshot {
	id: ServiceStatusId;
	label: string;
	statusUrl: string;
	iconType: ServiceStatusIconType;
	iconValue: string | null;
	sortOrder: number;
	level: ServiceStatusLevel;
	indicator: StatuspageIndicator | null;
	description: string;
	checkedAt: number;
	fetchError: string | null;
}

export function indicatorToLevel(
	indicator: StatuspageIndicator | null | undefined,
): ServiceStatusLevel {
	switch (indicator) {
		case "none":
			return "operational";
		case "minor":
		case "maintenance":
			return "minor";
		case "major":
			return "major";
		case "critical":
			return "critical";
		default:
			return "unknown";
	}
}

export function createUnknownSnapshot(
	def: ServiceStatusDefinition,
): ServiceStatusSnapshot {
	return {
		id: def.id,
		label: def.label,
		statusUrl: def.statusUrl,
		iconType: def.iconType,
		iconValue: def.iconValue,
		sortOrder: def.sortOrder,
		level: "unknown",
		indicator: null,
		description: "確認中…",
		checkedAt: 0,
		fetchError: null,
	};
}
