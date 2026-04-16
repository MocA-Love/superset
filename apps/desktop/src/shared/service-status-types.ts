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

export interface ServiceStatusDefinition {
	id: "claude" | "codex";
	label: string;
	statusUrl: string;
	apiUrl: string;
}

export interface ServiceStatusSnapshot {
	id: ServiceStatusDefinition["id"];
	label: string;
	statusUrl: string;
	level: ServiceStatusLevel;
	indicator: StatuspageIndicator | null;
	description: string;
	checkedAt: number;
	fetchError: string | null;
}

export const SERVICE_STATUS_DEFINITIONS: ServiceStatusDefinition[] = [
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
];

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
