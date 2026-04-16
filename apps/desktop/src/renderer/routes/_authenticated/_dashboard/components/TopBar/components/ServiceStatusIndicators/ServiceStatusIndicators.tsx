import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	createUnknownSnapshot,
	SERVICE_STATUS_DEFINITIONS,
	type ServiceStatusId,
	type ServiceStatusLevel,
	type ServiceStatusSnapshot,
} from "shared/service-status-types";

const LEVEL_CLASS: Record<ServiceStatusLevel, string> = {
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

/**
 * Safely pick a host string for the tooltip footer. `new URL` throws on
 * malformed input — rare for the hardcoded statusUrls, but guarding here
 * keeps a bad upstream value from taking down the whole TopBar via React's
 * render-error boundary.
 */
function hostOrFallback(statusUrl: string, fallback: string): string {
	try {
		return new URL(statusUrl).host;
	} catch {
		return fallback;
	}
}

interface ServiceStatusDotProps {
	snapshot: ServiceStatusSnapshot;
	onClick: () => void;
}

function ServiceStatusDot({ snapshot, onClick }: ServiceStatusDotProps) {
	const colorClass = LEVEL_CLASS[snapshot.level];
	const levelLabel = LEVEL_LABEL[snapshot.level];
	const displayHost = hostOrFallback(snapshot.statusUrl, snapshot.label);

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onClick}
					aria-label={`${snapshot.label} status: ${levelLabel}`}
					className="no-drag flex items-center justify-center size-6 rounded-md hover:bg-accent/50 transition-colors"
				>
					<span
						className={`size-2.5 rounded-full ${colorClass} ring-1 ring-black/10 dark:ring-white/10`}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="text-xs">
				<div className="font-medium">
					{snapshot.label} — {levelLabel}
				</div>
				<div className="text-muted-foreground">{snapshot.description}</div>
				<div className="text-muted-foreground/80 mt-0.5">
					{formatCheckedAt(snapshot.checkedAt)}
					{snapshot.fetchError ? ` · ${snapshot.fetchError}` : ""}
				</div>
				<div className="text-muted-foreground/60 mt-0.5">
					クリックで {displayHost} を開く
				</div>
			</TooltipContent>
		</Tooltip>
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
		<div className="no-drag flex items-center gap-0.5">
			{ordered.map((snapshot) => (
				<ServiceStatusDot
					key={snapshot.id}
					snapshot={snapshot}
					onClick={() => openUrl.mutate(snapshot.statusUrl)}
				/>
			))}
		</div>
	);
}
