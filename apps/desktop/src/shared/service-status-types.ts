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

export type ServiceStatusId = "claude" | "codex";

export interface ServiceStatusDefinition {
	id: ServiceStatusId;
	label: string;
	statusUrl: string;
	apiUrl: string;
}

export const SERVICE_STATUS_DEFINITIONS = [
	{
		id: "claude",
		label: "Claude",
		statusUrl: "https://status.claude.com/",
		apiUrl: "https://status.claude.com/api/v2/status.json",
	},
	{
		id: "codex",
		label: "Codex",
		statusUrl: "https://status.openai.com/",
		apiUrl: "https://status.openai.com/api/v2/status.json",
	},
] as const satisfies readonly ServiceStatusDefinition[];

export interface ServiceStatusSnapshot {
	id: ServiceStatusId;
	label: string;
	statusUrl: string;
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
		level: "unknown",
		indicator: null,
		description: "確認中…",
		checkedAt: 0,
		fetchError: null,
	};
}
