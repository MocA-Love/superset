import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	formatCheckedAt,
	LEVEL_DOT_CLASS,
	LEVEL_LABEL,
} from "renderer/lib/service-status/level-display";
import { ServiceStatusIcon } from "renderer/lib/service-status/ServiceStatusIcon";
import type { ServiceStatusSnapshot } from "shared/service-status-types";

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
	onManage: () => void;
}

function ServiceStatusIndicator({
	snapshot,
	onOpenStatusPage,
	onManage,
}: ServiceStatusIndicatorProps) {
	const dotClass = LEVEL_DOT_CLASS[snapshot.level];
	const levelLabel = LEVEL_LABEL[snapshot.level];
	const displayHost = hostOrFallback(snapshot.statusUrl, snapshot.label);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`${snapshot.label} status: ${levelLabel}`}
					className="no-drag relative flex items-center justify-center size-[25px] rounded-md text-foreground/80 hover:text-foreground hover:bg-accent/60 transition-colors"
				>
					<ServiceStatusIcon
						source={snapshot}
						className="size-[13px] shrink-0"
					/>
					<span
						className={`absolute -bottom-px -right-px size-1.5 rounded-full ring-[1.5px] ring-background ${dotClass}`}
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				className="p-3 max-w-[280px] w-auto space-y-1.5 text-sm"
			>
				<div className="flex items-center gap-1.5 font-semibold">
					<ServiceStatusIcon source={snapshot} className="size-3.5 shrink-0" />
					<span>{snapshot.label}</span>
					<span className="text-muted-foreground">—</span>
					<span>{levelLabel}</span>
				</div>
				<div>{snapshot.description}</div>
				<div className="text-xs text-muted-foreground">
					{formatCheckedAt(snapshot.checkedAt)}
					{snapshot.fetchError ? ` · ${snapshot.fetchError}` : ""}
				</div>
				<div className="flex items-center justify-between pt-1">
					<button
						type="button"
						onClick={onOpenStatusPage}
						className="text-xs text-primary hover:underline focus:outline-none focus-visible:underline"
					>
						{displayHost} を開く
					</button>
					<button
						type="button"
						onClick={onManage}
						aria-label="サービスを管理"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:underline"
					>
						<HiOutlineCog6Tooth className="size-3.5" />
						管理
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function ServiceStatusIndicators() {
	const navigate = useNavigate();
	const [snapshots, setSnapshots] = useState<
		Map<string, ServiceStatusSnapshot>
	>(() => new Map());

	electronTrpc.serviceStatus.onChange.useSubscription(undefined, {
		onData: (event) => {
			if ("removedId" in event) {
				const removedId = event.removedId;
				setSnapshots((prev) => {
					if (!prev.has(removedId)) return prev;
					const next = new Map(prev);
					next.delete(removedId);
					return next;
				});
				return;
			}
			const snapshot = event;
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
			[...snapshots.values()].sort(
				(a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
			),
		[snapshots],
	);

	if (ordered.length === 0) return null;

	return (
		<div className="no-drag flex items-center gap-1 mr-2">
			{ordered.map((snapshot) => (
				<ServiceStatusIndicator
					key={snapshot.id}
					snapshot={snapshot}
					onOpenStatusPage={() => openUrl.mutate(snapshot.statusUrl)}
					onManage={() =>
						navigate({ to: "/settings/service-status" }).catch(() => {
							// Navigation errors here mean the route tree hasn't been
							// code-split yet — swallow so the click doesn't throw.
						})
					}
				/>
			))}
		</div>
	);
}
