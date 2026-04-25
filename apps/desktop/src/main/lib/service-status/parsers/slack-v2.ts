import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * Slack publishes a custom status payload at slack-status.com/api/v2.0.0/current:
 *
 *   {
 *     "status": "ok" | "active",
 *     "active_incidents": [
 *       { id, title, type, status, services, ... }
 *     ]
 *   }
 *
 * `type` per incident is one of "incident" | "outage" | "notice" | "maintenance"
 * (observed values; no public schema). We pick the worst type across the
 * active incidents and map it onto the Statuspage indicator scale so the rest
 * of the app doesn't need a Slack-specific code path.
 */

type SlackIncidentType = "incident" | "outage" | "notice" | "maintenance";

interface SlackIncident {
	id?: number;
	title?: string;
	type?: SlackIncidentType | string;
	status?: string;
	services?: string[];
}

interface SlackStatusResponse {
	status?: string;
	active_incidents?: SlackIncident[];
}

const SEVERITY_RANK: Record<string, number> = {
	notice: 1,
	maintenance: 2,
	incident: 3,
	outage: 4,
};

export async function fetchSlackV2(apiUrl: string): Promise<ParsedStatus> {
	const json = await fetchJson<SlackStatusResponse>(apiUrl);
	const status = (json.status ?? "").toLowerCase();
	const incidents = Array.isArray(json.active_incidents)
		? json.active_incidents
		: [];

	if (status === "ok" && incidents.length === 0) {
		return { indicator: "none", description: "全システム正常" };
	}

	if (incidents.length === 0) {
		// status !== "ok" but no incident details — surface the bare status.
		return {
			indicator: null,
			description: status ? `Slack ステータス: ${status}` : "ステータス不明",
		};
	}

	const worst = incidents.reduce((best, incident) => {
		const bestRank = SEVERITY_RANK[(best.type ?? "").toLowerCase()] ?? 0;
		const currentRank = SEVERITY_RANK[(incident.type ?? "").toLowerCase()] ?? 0;
		return currentRank > bestRank ? incident : best;
	}, incidents[0]);

	const worstType = (worst.type ?? "").toLowerCase();
	let indicator: ParsedStatus["indicator"];
	switch (worstType) {
		case "outage":
			indicator = "critical";
			break;
		case "incident":
			indicator = "major";
			break;
		case "maintenance":
			indicator = "maintenance";
			break;
		case "notice":
			indicator = "minor";
			break;
		default:
			indicator = "minor";
	}

	const title = worst.title?.trim() || "進行中のインシデントあり";
	const description =
		incidents.length > 1
			? `${title} (他 ${incidents.length - 1} 件)`.slice(0, 180)
			: title.slice(0, 180);

	return { indicator, description };
}
