import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * AWS publishes a combined JSON snapshot at `status.aws.amazon.com/data.json`:
 *
 *   {
 *     "archive": [...resolved events...],
 *     "current": [{ service_name, summary, date, description, status }, ...]
 *   }
 *
 * `status` is a stringified integer:
 *   - "0" — informational / normal (seldom appears in `current`)
 *   - "1" — informational message
 *   - "2" — service performance issues (degraded)
 *   - "3" — service disruption (outage)
 *
 * We aggregate to the worst status across all current events and fall back to
 * `unknown` if the JSON shape is unexpected. AWS has changed endpoints more
 * than once historically — we prefer the stable data.json over the newer but
 * CORS-protected health.aws endpoints.
 */

interface AwsEvent {
	service_name?: string;
	summary?: string;
	description?: string;
	status?: string | number;
}

interface AwsSnapshot {
	current?: AwsEvent[];
	archive?: unknown;
}

export async function fetchAwsHealth(apiUrl: string): Promise<ParsedStatus> {
	const json = await fetchJson<unknown>(apiUrl);
	// Strict shape check — AWS has reshaped this endpoint in the past, so we
	// return `unknown` on anything we don't recognize rather than silently
	// falling back to "operational" and hiding an outage from the user.
	if (
		!json ||
		typeof json !== "object" ||
		!Array.isArray((json as AwsSnapshot).current)
	) {
		return {
			indicator: null,
			description: "AWS data.json の形式が想定と違います",
		};
	}
	const current = (json as AwsSnapshot).current ?? [];
	if (current.length === 0) {
		return { indicator: "none", description: "全システム正常" };
	}
	const worst = current.reduce((best, event) => {
		const bestRank = Number(best.status) || 0;
		const currentRank = Number(event.status) || 0;
		return currentRank > bestRank ? event : best;
	}, current[0]);
	const worstRank = Number(worst.status) || 0;
	let indicator: ParsedStatus["indicator"];
	if (worstRank >= 3) indicator = "major";
	else if (worstRank >= 2) indicator = "minor";
	else indicator = "none"; // informational only — don't alarm the user
	const description =
		[worst.service_name, worst.summary]
			.filter(Boolean)
			.join(": ")
			.slice(0, 180) || `${current.length} 件の進行中イベント`;
	return { indicator, description };
}
