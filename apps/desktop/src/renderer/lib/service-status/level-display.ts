import type { ServiceStatusLevel } from "shared/service-status-types";

/**
 * Shared styling / labels for Service Status levels. Kept in one place so the
 * TopBar popover and the Settings dashboard can't drift (they did during
 * review — "ステータス不明" vs "不明" for the same state).
 */

export const LEVEL_DOT_CLASS: Record<ServiceStatusLevel, string> = {
	operational: "bg-emerald-500",
	minor: "bg-amber-400",
	major: "bg-red-500",
	critical: "bg-purple-500",
	unknown: "bg-zinc-400 dark:bg-zinc-500",
};

export const LEVEL_LABEL: Record<ServiceStatusLevel, string> = {
	operational: "正常",
	minor: "軽微な障害",
	major: "障害発生中",
	critical: "重大な障害",
	unknown: "ステータス不明",
};

export function formatCheckedAt(checkedAt: number): string {
	if (!checkedAt) return "未確認";
	const diff = Date.now() - checkedAt;
	if (diff < 60_000) return "たった今確認";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}分前に確認`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}時間前に確認`;
	return new Date(checkedAt).toLocaleString();
}
