import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { SiClaude, SiOpenai } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	createUnknownSnapshot,
	SERVICE_STATUS_DEFINITIONS,
	type ServiceStatusId,
	type ServiceStatusLevel,
	type ServiceStatusSnapshot,
} from "shared/service-status-types";

const LEVEL_DOT_CLASS: Record<ServiceStatusLevel, string> = {
	operational: "bg-emerald-500",
	minor: "bg-amber-400",
	major: "bg-red-500",
	critical: "bg-purple-500",
	unknown: "bg-zinc-400 dark:bg-zinc-500",
};

const LEVEL_LABEL: Record<ServiceStatusLevel, string> = {
	operational: "正常",
	minor: "軽微な障害",
	major: "障害発生中",
	critical: "重大な障害",
	unknown: "ステータス不明",
};

const SERVICE_ICON: Record<ServiceStatusId, IconType> = {
	claude: SiClaude,
	codex: SiOpenai,
};

function formatCheckedAt(checkedAt: number): string {
	if (!checkedAt) return "未確認";
	const diff = Date.now() - checkedAt;
	if (diff < 60_000) return "たった今確認";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}分前に確認`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}時間前に確認`;
	return new Date(checkedAt).toLocaleString();
}

function hostOrFallback(statusUrl: string, fallback: string): string {
	try {
		return new URL(statusUrl).host;
	} catch {
		return fallback;
	}
}

interface ServiceStatusIndicatorProps {
	snapshot: ServiceStatusSnapshot;
	onOpenStatusPage: () => void;
}

function ServiceStatusIndicator({
	snapshot,
	onOpenStatusPage,
}: ServiceStatusIndicatorProps) {
	const dotClass = LEVEL_DOT_CLASS[snapshot.level];
	const levelLabel = LEVEL_LABEL[snapshot.level];
	const displayHost = hostOrFallback(snapshot.statusUrl, snapshot.label);
	const Icon = SERVICE_ICON[snapshot.id];

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`${snapshot.label} status: ${levelLabel}`}
					className="no-drag relative flex items-center justify-center size-7 rounded-md text-foreground/80 hover:text-foreground hover:bg-accent/60 transition-colors"
				>
					<Icon className="size-[15px]" />
					<span
						className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background ${dotClass}`}
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				className="p-3 max-w-[280px] w-auto space-y-1.5 text-sm"
			>
				<div className="flex items-center gap-1.5 font-semibold">
					<Icon className="size-3.5 shrink-0" />
					<span>{snapshot.label}</span>
					<span className="text-muted-foreground">—</span>
					<span>{levelLabel}</span>
				</div>
				<div>{snapshot.description}</div>
				<div className="text-xs text-muted-foreground">
					{formatCheckedAt(snapshot.checkedAt)}
					{snapshot.fetchError ? ` · ${snapshot.fetchError}` : ""}
				</div>
				<button
					type="button"
					onClick={onOpenStatusPage}
					className="text-xs text-primary hover:underline focus:outline-none focus-visible:underline"
				>
					{displayHost} を開く
				</button>
			</PopoverContent>
		</Popover>
	);
}

function initialSnapshots(): Map<ServiceStatusId, ServiceStatusSnapshot> {
	const map = new Map<ServiceStatusId, ServiceStatusSnapshot>();
	for (const def of SERVICE_STATUS_DEFINITIONS) {
		map.set(def.id, createUnknownSnapshot(def));
	}
	return map;
}

export function ServiceStatusIndicators() {
	const [snapshots, setSnapshots] = useState(initialSnapshots);

	electronTrpc.serviceStatus.onChange.useSubscription(undefined, {
		onData: (snapshot: ServiceStatusSnapshot) => {
			setSnapshots((prev) => {
				const next = new Map(prev);
				next.set(snapshot.id, snapshot);
				return next;
			});
		},
	});

	const openUrl = electronTrpc.external.openUrl.useMutation();

	const ordered = useMemo(
		() =>
			SERVICE_STATUS_DEFINITIONS.map(
				(def) => snapshots.get(def.id) ?? createUnknownSnapshot(def),
			),
		[snapshots],
	);

	return (
		<div className="no-drag flex items-center gap-1">
			{ordered.map((snapshot) => (
				<ServiceStatusIndicator
					key={snapshot.id}
					snapshot={snapshot}
					onOpenStatusPage={() => openUrl.mutate(snapshot.statusUrl)}
				/>
			))}
		</div>
	);
}
