import { fetchJson } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * status.io (api.status.io/1.0/status/<page_id>) shape:
 *
 *   { result: { status_overall: { status_code: number, status: string } } }
 *
 * status_code values per https://kb.status.io/developers/status-codes/:
 *   100 — Operational
 *   200 — Planned Maintenance
 *   300 — Degraded Performance
 *   400 — Partial Service Disruption
 *   500 — Service Disruption
 *   600 — Security Event
 *
 * Used by GitLab and Docker Hub which moved off Atlassian Statuspage.
 */

interface StatusIoResponse {
	result?: {
		status_overall?: {
			status_code?: number;
			status?: string;
		};
	};
}

export async function fetchStatusIo(apiUrl: string): Promise<ParsedStatus> {
	const json = await fetchJson<StatusIoResponse>(apiUrl);
	const overall = json.result?.status_overall;
	const code = overall?.status_code;
	const status = overall?.status?.trim() || "";

	if (typeof code !== "number") {
		return {
			indicator: null,
			description: "status.io レスポンスの形式が想定と違います",
		};
	}

	let indicator: ParsedStatus["indicator"];
	let fallbackLabel: string;
	switch (code) {
		case 100:
			indicator = "none";
			fallbackLabel = "全システム正常";
			break;
		case 200:
			indicator = "maintenance";
			fallbackLabel = "メンテナンス中";
			break;
		case 300:
			indicator = "minor";
			fallbackLabel = "パフォーマンス低下";
			break;
		case 400:
			indicator = "major";
			fallbackLabel = "一部機能で障害発生";
			break;
		case 500:
			indicator = "critical";
			fallbackLabel = "サービス停止中";
			break;
		case 600:
			indicator = "critical";
			fallbackLabel = "セキュリティ事象";
			break;
		default:
			indicator = null;
			fallbackLabel = "ステータス不明";
	}

	return { indicator, description: status || fallbackLabel };
}
