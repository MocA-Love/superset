import type { StatuspageIndicator } from "shared/service-status-types";
import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

type StatuspageResponse = {
	status?: { indicator?: StatuspageIndicator; description?: string };
};

/**
 * Official Statuspage.io v2 shape — the original (and still most common)
 * status format supported by the app. See
 * https://doers.statuspage.io/api/v2/pages/#status
 */
export async function fetchStatuspageV2(apiUrl: string): Promise<ParsedStatus> {
	const json = await fetchJson<StatuspageResponse>(apiUrl);
	const indicator = json.status?.indicator ?? null;
	const description =
		json.status?.description ||
		(indicator === "none" ? "全システム正常" : "ステータス不明");
	return { indicator, description };
}
