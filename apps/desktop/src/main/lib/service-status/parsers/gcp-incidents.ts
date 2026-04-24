import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * GCP publishes an array of incidents (past + current) at
 * `status.cloud.google.com/incidents.json`. We care about the ones that are
 * still active — those don't have an `end` timestamp yet — and pick the
 * highest severity among them so the indicator dot matches the site's banner.
 *
 * Severity taxonomy (as of late 2024):
 *   - `high`   → service outage, maps to `major`
 *   - `medium` → service disruption, maps to `minor`
 *   - `low`    → service information / minor disruption, maps to `minor`
 *
 * See the "Severity levels" section of the GCP status page for the current
 * list; unknown severities fall through to `minor` to avoid silently greening
 * them out.
 */

interface GcpIncident {
	id?: string;
	external_desc?: string;
	severity?: "high" | "medium" | "low" | string;
	end?: string | null;
}

const SEVERITY_RANK: Record<string, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

export async function fetchGcpIncidents(apiUrl: string): Promise<ParsedStatus> {
	const json = await fetchJson<unknown>(apiUrl);
	if (!Array.isArray(json)) {
		return {
			indicator: null,
			description: "GCP incidents.json の形式が想定と違います",
		};
	}
	const incidents = json as GcpIncident[];
	const active = incidents.filter((i) => !i.end);
	if (active.length === 0) {
		return { indicator: "none", description: "全システム正常" };
	}
	const worst = active.reduce<GcpIncident>((best, current) => {
		const bestRank = SEVERITY_RANK[best.severity ?? ""] ?? 0;
		const currentRank = SEVERITY_RANK[current.severity ?? ""] ?? 0;
		return currentRank > bestRank ? current : best;
	}, active[0]);
	const worstRank = SEVERITY_RANK[worst.severity ?? ""] ?? 0;
	const indicator = worstRank >= 3 ? "major" : "minor";
	const description =
		worst.external_desc?.slice(0, 180) ||
		`${active.length} 件の進行中インシデント`;
	return { indicator, description };
}
