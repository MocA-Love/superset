import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { cn } from "@superset/ui/utils";

export type Frequency = "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface FrequencyValue {
	frequency: Frequency;
	minute: number | null;
	hour: number | null;
	weekday: number | null;
	monthday: number | null;
	cronExpr: string | null;
}

interface FrequencyPickerProps {
	value: FrequencyValue;
	onChange: (next: FrequencyValue) => void;
	disabled?: boolean;
}

const WEEKDAYS = [
	{ value: 0, label: "日" },
	{ value: 1, label: "月" },
	{ value: 2, label: "火" },
	{ value: 3, label: "水" },
	{ value: 4, label: "木" },
	{ value: 5, label: "金" },
	{ value: 6, label: "土" },
];

function clampInt(raw: string, min: number, max: number): number | null {
	if (raw === "") return null;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) return null;
	return Math.min(max, Math.max(min, n));
}

export function FrequencyPicker({
	value,
	onChange,
	disabled,
}: FrequencyPickerProps) {
	const patch = (partial: Partial<FrequencyValue>) => {
		onChange({ ...value, ...partial });
	};

	const setFrequency = (frequency: Frequency) => {
		// Re-seed sensible defaults whenever the frequency changes so each
		// field has a visible starting value instead of the previous
		// frequency's empty slots.
		const base: FrequencyValue = {
			frequency,
			minute: null,
			hour: null,
			weekday: null,
			monthday: null,
			cronExpr: null,
		};
		switch (frequency) {
			case "hourly":
				base.minute = value.minute ?? 0;
				break;
			case "daily":
				base.hour = value.hour ?? 9;
				base.minute = value.minute ?? 0;
				break;
			case "weekly":
				base.weekday = value.weekday ?? 1;
				base.hour = value.hour ?? 9;
				base.minute = value.minute ?? 0;
				break;
			case "monthly":
				base.monthday = value.monthday ?? 1;
				base.hour = value.hour ?? 9;
				base.minute = value.minute ?? 0;
				break;
			case "custom":
				base.cronExpr = value.cronExpr ?? "0 9 * * *";
				break;
		}
		onChange(base);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">頻度</Label>
				<Select
					value={value.frequency}
					onValueChange={(v) => setFrequency(v as Frequency)}
					disabled={disabled}
				>
					<SelectTrigger className="h-8 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="hourly">毎時</SelectItem>
						<SelectItem value="daily">毎日</SelectItem>
						<SelectItem value="weekly">毎週</SelectItem>
						<SelectItem value="monthly">毎月</SelectItem>
						<SelectItem value="custom">カスタム (cron)</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{value.frequency === "hourly" && (
				<div className="flex items-center gap-2">
					<Label className="text-xs w-20 shrink-0">毎時 :</Label>
					<Input
						type="number"
						min={0}
						max={59}
						value={value.minute ?? 0}
						onChange={(e) =>
							patch({ minute: clampInt(e.target.value, 0, 59) ?? 0 })
						}
						disabled={disabled}
						className="h-8 w-20 text-xs"
					/>
					<span className="text-xs text-muted-foreground">分</span>
				</div>
			)}

			{(value.frequency === "daily" ||
				value.frequency === "weekly" ||
				value.frequency === "monthly") && (
				<div className="flex items-center gap-2">
					<Label className="text-xs w-20 shrink-0">時刻</Label>
					<Input
						type="number"
						min={0}
						max={23}
						value={value.hour ?? 9}
						onChange={(e) =>
							patch({ hour: clampInt(e.target.value, 0, 23) ?? 9 })
						}
						disabled={disabled}
						className="h-8 w-20 text-xs"
					/>
					<span className="text-xs text-muted-foreground">時</span>
					<Input
						type="number"
						min={0}
						max={59}
						value={value.minute ?? 0}
						onChange={(e) =>
							patch({ minute: clampInt(e.target.value, 0, 59) ?? 0 })
						}
						disabled={disabled}
						className="h-8 w-20 text-xs"
					/>
					<span className="text-xs text-muted-foreground">分</span>
				</div>
			)}

			{value.frequency === "weekly" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">曜日</Label>
					<div className="flex gap-1">
						{WEEKDAYS.map((w) => {
							const selected = value.weekday === w.value;
							return (
								<button
									key={w.value}
									type="button"
									onClick={() => patch({ weekday: w.value })}
									disabled={disabled}
									className={cn(
										"h-8 w-8 rounded-md text-xs border transition-colors",
										selected
											? "bg-primary text-primary-foreground border-primary"
											: "hover:bg-accent",
										disabled && "opacity-50 cursor-not-allowed",
									)}
								>
									{w.label}
								</button>
							);
						})}
					</div>
				</div>
			)}

			{value.frequency === "monthly" && (
				<div className="flex items-center gap-2">
					<Label className="text-xs w-20 shrink-0">日</Label>
					<Input
						type="number"
						min={1}
						max={31}
						value={value.monthday ?? 1}
						onChange={(e) =>
							patch({ monthday: clampInt(e.target.value, 1, 31) ?? 1 })
						}
						disabled={disabled}
						className="h-8 w-20 text-xs"
					/>
					<span className="text-xs text-muted-foreground">日</span>
				</div>
			)}

			{value.frequency === "custom" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">cron 式</Label>
					<Input
						value={value.cronExpr ?? ""}
						onChange={(e) => patch({ cronExpr: e.target.value })}
						placeholder="0 9 * * * (毎日 9:00)"
						disabled={disabled}
						className="h-8 text-xs font-mono"
					/>
					<p className="text-[10px] text-muted-foreground">
						5 フィールド形式 (分 時 日 月 曜)。秒は使えません。
					</p>
				</div>
			)}
		</div>
	);
}
