// Load only the ja locale instead of cronstrue/i18n, which pulls every
// locale (~200KB) into the renderer bundle even though we only render ja.
import cronstrue from "cronstrue";
import "cronstrue/locales/ja";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function padTwo(value: number): string {
	return value.toString().padStart(2, "0");
}

interface ScheduleCadenceInput {
	frequency: "hourly" | "daily" | "weekly" | "monthly" | "custom";
	minute: number | null | undefined;
	hour: number | null | undefined;
	weekday: number | null | undefined;
	monthday: number | null | undefined;
	cronExpr: string | null | undefined;
}

/**
 * Render a schedule's cadence as a Japanese one-liner users can quickly
 * skim. For `custom` we delegate to cronstrue so arbitrary cron strings
 * are readable without the user having to mentally parse them.
 */
export function describeSchedule(input: ScheduleCadenceInput): string {
	const minute = input.minute ?? 0;
	const hour = input.hour ?? 0;

	switch (input.frequency) {
		case "hourly":
			return `毎時 ${padTwo(minute)}分`;
		case "daily":
			return `毎日 ${padTwo(hour)}:${padTwo(minute)}`;
		case "weekly": {
			const day = WEEKDAY_LABELS[input.weekday ?? 0] ?? "";
			return `毎週${day}曜 ${padTwo(hour)}:${padTwo(minute)}`;
		}
		case "monthly": {
			const md = input.monthday ?? 1;
			return `毎月${md}日 ${padTwo(hour)}:${padTwo(minute)}`;
		}
		case "custom": {
			if (!input.cronExpr) return "未設定";
			try {
				return cronstrue.toString(input.cronExpr, { locale: "ja" });
			} catch {
				return input.cronExpr;
			}
		}
	}
}
