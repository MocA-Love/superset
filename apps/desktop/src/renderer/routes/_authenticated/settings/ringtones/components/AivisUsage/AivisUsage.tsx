import { useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface Props {
	visibleItems?: SettingItemId[] | null;
}

type Period = "7" | "30" | "custom";

function toISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function rangeFor(period: Period): {
	start: string;
	end: string;
	days: number;
} {
	const end = new Date();
	const start = new Date();
	const days = period === "7" ? 7 : 30;
	start.setDate(end.getDate() - (days - 1));
	return { start: toISODate(start), end: toISODate(end), days };
}

function fillMissingDates(
	days: Array<{
		date: string;
		requestCount: number;
		characterCount: number;
		creditConsumed: number;
	}>,
	start: string,
	end: string,
) {
	const result: typeof days = [];
	const map = new Map(days.map((d) => [d.date, d]));
	const s = new Date(`${start}T00:00:00`);
	const e = new Date(`${end}T00:00:00`);
	for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
		const key = toISODate(d);
		result.push(
			map.get(key) ?? {
				date: key,
				requestCount: 0,
				characterCount: 0,
				creditConsumed: 0,
			},
		);
	}
	return result;
}

type Metric = "credits" | "requests" | "chars";

export function AivisUsage({ visibleItems }: Props) {
	const visible = isItemVisible(
		SETTING_ITEM_ID.RINGTONES_AIVIS_USAGE,
		visibleItems,
	);

	const { data: aivisSettings } =
		electronTrpc.settings.getAivisSettings.useQuery();
	const apiKey = aivisSettings?.apiKey ?? "";

	const [period, setPeriod] = useState<Period>("30");
	const [metric, setMetric] = useState<Metric>("credits");
	const range = useMemo(
		() => rangeFor(period === "custom" ? "30" : period),
		[period],
	);

	const usage = electronTrpc.aivis.usage.daily.useQuery(
		{ startDate: range.start, endDate: range.end },
		{ enabled: Boolean(apiKey), retry: false, staleTime: 5 * 60 * 1000 },
	);
	const me = electronTrpc.aivis.usage.me.useQuery(undefined, {
		enabled: Boolean(apiKey),
		retry: false,
		staleTime: 5 * 60 * 1000,
	});

	const filled = useMemoFilled(usage.data?.days ?? [], range.start, range.end);
	const total = usage.data?.total ?? {
		requestCount: 0,
		characterCount: 0,
		creditConsumed: 0,
	};
	const maxValue = Math.max(
		1,
		...filled.map((d) =>
			metric === "credits"
				? d.creditConsumed
				: metric === "requests"
					? d.requestCount
					: d.characterCount,
		),
	);

	const apiKeyBreakdown = useMemo(() => {
		const agg = new Map<
			string,
			{
				name: string;
				requestCount: number;
				characterCount: number;
				creditConsumed: number;
			}
		>();
		for (const d of usage.data?.days ?? []) {
			for (const [id, b] of Object.entries(d.byApiKey)) {
				const prev = agg.get(id) ?? {
					name: b.name,
					requestCount: 0,
					characterCount: 0,
					creditConsumed: 0,
				};
				prev.requestCount += b.requestCount;
				prev.characterCount += b.characterCount;
				prev.creditConsumed += b.creditConsumed;
				agg.set(id, prev);
			}
		}
		return [...agg.entries()].sort(
			(a, b) => b[1].creditConsumed - a[1].creditConsumed,
		);
	}, [usage.data]);

	if (!visible) return null;

	return (
		<div className="pt-6 border-t space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-base font-semibold">使用量 (日別)</h3>
					<p className="text-sm text-muted-foreground mt-1">
						Aivis API
						のリクエスト数・文字数・クレジット消費を日別に集計します。5
						分キャッシュ。
					</p>
				</div>
				<div className="shrink-0 inline-flex rounded-md border bg-muted p-0.5 text-xs">
					<PeriodBtn active={period === "7"} onClick={() => setPeriod("7")}>
						7日
					</PeriodBtn>
					<PeriodBtn active={period === "30"} onClick={() => setPeriod("30")}>
						30日
					</PeriodBtn>
				</div>
			</div>

			{!apiKey && (
				<div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
					Aivis API キーを設定すると使用量を表示できます。
				</div>
			)}

			{apiKey && usage.error && (
				<div className="text-sm text-destructive">
					使用量の取得に失敗しました: {usage.error.message}
				</div>
			)}

			{apiKey && (
				<>
					<div className="grid grid-cols-3 gap-3">
						<StatCard
							label="Requests"
							value={total.requestCount.toLocaleString()}
							sub={
								total.requestCount > 0
									? `平均 ${(total.characterCount / total.requestCount).toFixed(1)} 文字/回`
									: "—"
							}
						/>
						<StatCard
							label="Characters"
							value={total.characterCount.toLocaleString()}
							sub={`${range.days}日間合計`}
						/>
						<StatCard
							label="Credits consumed"
							value={total.creditConsumed.toFixed(2)}
							sub={
								me.data?.creditBalance !== null &&
								me.data?.creditBalance !== undefined
									? `残高 ${me.data.creditBalance.toLocaleString()}`
									: "—"
							}
						/>
					</div>

					<div className="rounded-lg border bg-card p-4">
						<div className="flex items-center justify-between mb-3">
							<div className="text-xs font-medium">
								日別 {metricLabel(metric)}
							</div>
							<div className="inline-flex rounded border bg-muted p-0.5 text-[11px]">
								<MetricBtn
									active={metric === "credits"}
									onClick={() => setMetric("credits")}
								>
									Credits
								</MetricBtn>
								<MetricBtn
									active={metric === "requests"}
									onClick={() => setMetric("requests")}
								>
									Requests
								</MetricBtn>
								<MetricBtn
									active={metric === "chars"}
									onClick={() => setMetric("chars")}
								>
									Chars
								</MetricBtn>
							</div>
						</div>
						<div className="flex items-end gap-[2px] h-36">
							{filled.map((d) => {
								const val =
									metric === "credits"
										? d.creditConsumed
										: metric === "requests"
											? d.requestCount
											: d.characterCount;
								const h = (val / maxValue) * 100;
								return (
									<div
										key={d.date}
										className="flex-1 bg-gradient-to-t from-emerald-500 to-emerald-400 rounded-t-sm relative group min-h-[2px]"
										style={{ height: `${Math.max(2, h)}%` }}
									>
										<div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-popover border text-[10px] whitespace-nowrap z-10">
											{d.date.slice(5)} · {formatMetric(metric, val)}
										</div>
									</div>
								);
							})}
						</div>
						<div className="flex justify-between text-[10px] text-muted-foreground mt-2 tabular-nums">
							<span>{range.start.slice(5)}</span>
							<span>{range.end.slice(5)}</span>
						</div>
					</div>

					<div className="rounded-lg border overflow-hidden">
						<table className="w-full text-xs">
							<thead className="bg-muted text-muted-foreground">
								<tr>
									<th className="text-left font-medium px-3 py-2">日付</th>
									<th className="text-right font-medium px-3 py-2">Requests</th>
									<th className="text-right font-medium px-3 py-2">Chars</th>
									<th className="text-right font-medium px-3 py-2">Credits</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{filled
									.slice()
									.reverse()
									.slice(0, 10)
									.map((d) => (
										<tr key={d.date} className="hover:bg-muted/30">
											<td className="px-3 py-1.5 tabular-nums">{d.date}</td>
											<td className="px-3 py-1.5 text-right tabular-nums">
												{d.requestCount.toLocaleString()}
											</td>
											<td className="px-3 py-1.5 text-right tabular-nums">
												{d.characterCount.toLocaleString()}
											</td>
											<td className="px-3 py-1.5 text-right tabular-nums text-emerald-500">
												{d.creditConsumed.toFixed(2)}
											</td>
										</tr>
									))}
								{filled.length > 10 && (
									<tr className="text-muted-foreground italic">
										<td className="px-3 py-1.5" colSpan={4}>
											…残り {filled.length - 10} 日
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>

					{apiKeyBreakdown.length > 1 && (
						<div className="rounded-lg border">
							<div className="px-4 py-2 text-xs font-medium text-muted-foreground">
								API キー別 ({apiKeyBreakdown.length} keys)
							</div>
							<div className="border-t divide-y">
								{apiKeyBreakdown.map(([id, b]) => (
									<div
										key={id}
										className="px-4 py-2.5 flex items-center justify-between"
									>
										<div className="text-sm font-mono truncate">{b.name}</div>
										<div className="text-right text-xs tabular-nums text-muted-foreground">
											{b.requestCount.toLocaleString()} req ·{" "}
											<span className="text-emerald-500">
												{b.creditConsumed.toFixed(2)}
											</span>{" "}
											credits
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

function useMemoFilled(
	days: Array<{
		date: string;
		requestCount: number;
		characterCount: number;
		creditConsumed: number;
	}>,
	start: string,
	end: string,
) {
	return useMemo(() => fillMissingDates(days, start, end), [days, start, end]);
}

function StatCard({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="text-[11px] uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && (
				<div className="text-[11px] text-muted-foreground mt-1">{sub}</div>
			)}
		</div>
	);
}

function PeriodBtn({
	active,
	children,
	onClick,
}: {
	active: boolean;
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`px-3 py-1 rounded ${
				active ? "bg-background shadow-sm" : "text-muted-foreground"
			}`}
		>
			{children}
		</button>
	);
}

function MetricBtn({
	active,
	children,
	onClick,
}: {
	active: boolean;
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`px-2 py-0.5 rounded ${
				active ? "bg-background" : "text-muted-foreground"
			}`}
		>
			{children}
		</button>
	);
}

function metricLabel(m: Metric): string {
	if (m === "credits") return "クレジット消費";
	if (m === "requests") return "リクエスト数";
	return "文字数";
}

function formatMetric(m: Metric, v: number): string {
	if (m === "credits") return `${v.toFixed(2)} credits`;
	if (m === "requests") return `${v.toLocaleString()} req`;
	return `${v.toLocaleString()} chars`;
}
