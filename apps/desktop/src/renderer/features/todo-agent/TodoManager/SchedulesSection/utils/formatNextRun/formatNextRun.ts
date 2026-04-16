/**
 * Format an epoch-ms timestamp as a human-readable "next run" label.
 * Returns "未設定" for null (e.g. disabled schedules or schedules with
 * malformed cron expressions).
 */
export function formatNextRun(nextRunAt: number | null): string {
	if (nextRunAt === null) return "未設定";

	const target = new Date(nextRunAt);
	const now = new Date();
	const diffMs = target.getTime() - now.getTime();

	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	const isToday =
		target.getFullYear() === now.getFullYear() &&
		target.getMonth() === now.getMonth() &&
		target.getDate() === now.getDate();

	const time = target.toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	});

	if (diffMs < 0) {
		return `${time} (処理待ち)`;
	}

	if (isToday) {
		if (diffMs < minute) return "まもなく";
		if (diffMs < hour) return `${Math.round(diffMs / minute)}分後 (${time})`;
		return `今日 ${time}`;
	}

	if (diffMs < 2 * day) {
		return `明日 ${time}`;
	}

	return target.toLocaleString("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
