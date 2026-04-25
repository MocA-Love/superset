import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * Instatus pages publish a tiny summary at `<page>/summary.json`:
 *
 *   { "page": { "name": "...", "url": "...", "status": "UP" | "HASISSUES" | "UNDERMAINTENANCE" } }
 *
 * Reference: https://instatus.com/help/api
 *
 * Used by Perplexity (and a growing number of providers migrating from
 * Atlassian Statuspage). We prefer summary.json over components.json because
 * it's a single-property response and avoids needing to aggregate per-component
 * statuses ourselves.
 */

interface InstatusSummary {
	page?: {
		name?: string;
		url?: string;
		status?: string;
	};
}

export async function fetchInstatusSummary(
	apiUrl: string,
): Promise<ParsedStatus> {
	const json = await fetchJson<InstatusSummary>(apiUrl);
	const status = (json.page?.status ?? "").toUpperCase();
	const name = json.page?.name?.trim() || "";

	switch (status) {
		case "UP":
			return { indicator: "none", description: "全システム正常" };
		case "HASISSUES":
			return {
				indicator: "major",
				description: name ? `${name} で障害発生中` : "障害発生中",
			};
		case "UNDERMAINTENANCE":
			return {
				indicator: "maintenance",
				description: "メンテナンス中",
			};
		default:
			return {
				indicator: null,
				description: status
					? `Instatus ステータス: ${status}`
					: "ステータス不明",
			};
	}
}
