import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useMemo } from "react";
import {
	HiOutlineArrowPath,
	HiOutlineClipboardDocument,
} from "react-icons/hi2";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search/settings-search";

interface MetricsSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

function formatDateTime(timestamp: number | null | undefined): string {
	if (!timestamp) {
		return "Never";
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "short",
		timeStyle: "medium",
	}).format(timestamp);
}

function formatRelative(timestamp: number | null | undefined): string {
	if (!timestamp) {
		return "Never";
	}

	const now = Date.now();
	const diffMs = now - timestamp;
	const isFuture = diffMs < 0;
	const absoluteDiffMs = Math.abs(diffMs);

	if (absoluteDiffMs < 1000) {
		return "just now";
	}

	const diffSeconds = Math.round(absoluteDiffMs / 1000);
	if (diffSeconds < 60) {
		return isFuture ? `in ${diffSeconds}s` : `${diffSeconds}s ago`;
	}

	const diffMinutes = Math.round(diffSeconds / 60);
	if (diffMinutes < 60) {
		return isFuture ? `in ${diffMinutes}m` : `${diffMinutes}m ago`;
	}

	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 24) {
		return isFuture ? `in ${diffHours}h` : `${diffHours}h ago`;
	}

	const diffDays = Math.round(diffHours / 24);
	return isFuture ? `in ${diffDays}d` : `${diffDays}d ago`;
}

function formatDuration(durationMs: number): string {
	if (durationMs >= 1000) {
		return `${(durationMs / 1000).toFixed(1)}s`;
	}

	return `${Math.round(durationMs)}ms`;
}

function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

function getCacheHitRatio(counts: {
	freshHits: number;
	staleHits: number;
	misses: number;
}): number {
	const total = counts.freshHits + counts.staleHits + counts.misses;
	if (total === 0) {
		return 0;
	}

	return ((counts.freshHits + counts.staleHits) / total) * 100;
}

export function MetricsSettings({ visibleItems }: MetricsSettingsProps) {
	const { copyToClipboard, copied } = useCopyToClipboard();
	const {
		data: snapshot,
		refetch,
		isFetching,
	} = electronTrpc.githubMetrics.getSnapshot.useQuery(undefined, {
		refetchInterval: 5000,
	});

	const topOperations = useMemo(
		() => (snapshot?.metrics.operations ?? []).slice(0, 12),
		[snapshot?.metrics.operations],
	);

	const copySummary = async () => {
		if (!snapshot) {
			return;
		}

		const topOperation = snapshot.metrics.operations[0];
		const summary = [
			`GitHub Metrics Summary (${formatDateTime(snapshot.generatedAt)})`,
			`Rate limit: ${snapshot.rateLimit.isRateLimited ? `active until ${formatDateTime(snapshot.rateLimit.resumeAt)}` : "clear"}`,
			`Active workspaces: ${snapshot.syncService.activeWorkspaceCount}/${snapshot.syncService.registeredWorkspaceCount}`,
			`5m calls: ${snapshot.metrics.totals.rolling5mCallCount}`,
			`5m failures: ${snapshot.metrics.totals.rolling5mFailureCount}`,
			`5m rate-limited: ${snapshot.metrics.totals.rolling5mRateLimitedCount}`,
			topOperation
				? `Top operation: ${topOperation.name} (${topOperation.rolling5m.calls} calls / 5m)`
				: "Top operation: none",
		].join("\n");

		try {
			await copyToClipboard(summary);
			toast.success("GitHub metrics summary copied");
		} catch (error) {
			toast.error(
				`Failed to copy summary: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const copyDebugBundle = async () => {
		if (!snapshot) {
			return;
		}

		try {
			await copyToClipboard(JSON.stringify(snapshot, null, 2));
			toast.success("GitHub debug bundle copied");
		} catch (error) {
			toast.error(
				`Failed to copy debug bundle: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const copyReproTemplate = async () => {
		if (!snapshot) {
			return;
		}

		const template = [
			"# GitHub Sync Debug Report",
			"",
			"## Context",
			"- What I was doing:",
			"- Expected behavior:",
			"- Actual behavior:",
			"",
			"## Snapshot",
			`- Captured at: ${formatDateTime(snapshot.generatedAt)}`,
			`- Rate limit active: ${snapshot.rateLimit.isRateLimited ? "yes" : "no"}`,
			`- Active workspaces: ${snapshot.syncService.activeWorkspaceCount}/${snapshot.syncService.registeredWorkspaceCount}`,
			`- Rolling 5m GitHub calls: ${snapshot.metrics.totals.rolling5mCallCount}`,
			`- Rolling 5m failures: ${snapshot.metrics.totals.rolling5mFailureCount}`,
			"",
			"## Last Errors",
			...(snapshot.metrics.lastErrors.length > 0
				? snapshot.metrics.lastErrors.slice(0, 5).map((error) => {
						const workspace = error.worktreePath
							? ` [${error.worktreePath}]`
							: "";
						return `- ${formatDateTime(error.at)} ${error.operation}${workspace}: ${error.message}`;
					})
				: ["- none"]),
			"",
			"## JSON Bundle",
			"```json",
			JSON.stringify(snapshot, null, 2),
			"```",
		].join("\n");

		try {
			await copyToClipboard(template);
			toast.success("GitHub repro template copied");
		} catch (error) {
			toast.error(
				`Failed to copy repro template: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return (
		<div className="p-6 max-w-6xl w-full">
			<div className="mb-8 flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold">Metrics</h2>
					<p className="text-sm text-muted-foreground mt-1">
						GitHub sync health, traffic, and debug-friendly copy actions for the
						desktop app.
					</p>
					<p className="text-xs text-muted-foreground mt-2">
						Last updated {formatRelative(snapshot?.generatedAt)}
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					<HiOutlineArrowPath
						className={`mr-1.5 h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
					/>
					Refresh
				</Button>
			</div>

			{isItemVisible(SETTING_ITEM_ID.METRICS_GITHUB_OVERVIEW, visibleItems) && (
				<section className="space-y-4">
					<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
						GitHub Overview
					</h3>

					<div className="grid gap-3 md:grid-cols-4">
						<div className="rounded-lg border p-4">
							<div className="text-xs text-muted-foreground">Rate Limit</div>
							<div className="mt-2 text-lg font-semibold">
								{snapshot?.rateLimit.isRateLimited ? "Paused" : "Clear"}
							</div>
							<div className="mt-1 text-xs text-muted-foreground">
								{snapshot?.rateLimit.isRateLimited
									? `Resumes ${formatRelative(snapshot.rateLimit.resumeAt)}`
									: "No active backoff"}
							</div>
						</div>

						<div className="rounded-lg border p-4">
							<div className="text-xs text-muted-foreground">
								Active Workspaces
							</div>
							<div className="mt-2 text-lg font-semibold">
								{snapshot
									? `${snapshot.syncService.activeWorkspaceCount}/${snapshot.syncService.registeredWorkspaceCount}`
									: "0/0"}
							</div>
							<div className="mt-1 text-xs text-muted-foreground">
								Tracked by backend GitHub scheduler
							</div>
						</div>

						<div className="rounded-lg border p-4">
							<div className="text-xs text-muted-foreground">
								Rolling 5m Calls
							</div>
							<div className="mt-2 text-lg font-semibold">
								{snapshot?.metrics.totals.rolling5mCallCount ?? 0}
							</div>
							<div className="mt-1 text-xs text-muted-foreground">
								Failures {snapshot?.metrics.totals.rolling5mFailureCount ?? 0}
							</div>
						</div>

						<div className="rounded-lg border p-4">
							<div className="text-xs text-muted-foreground">Latest Error</div>
							<div className="mt-2 text-sm font-medium">
								{snapshot?.metrics.lastErrors[0]?.operation ?? "None"}
							</div>
							<div className="mt-1 text-xs text-muted-foreground line-clamp-2">
								{snapshot?.metrics.lastErrors[0]?.message ?? "No recent errors"}
							</div>
						</div>
					</div>

					<div className="rounded-lg border">
						<div className="border-b px-4 py-3">
							<h4 className="text-sm font-medium">Scheduler State</h4>
						</div>
						<div className="divide-y">
							{snapshot?.syncService.workspaces.length ? (
								snapshot.syncService.workspaces.map((workspace) => (
									<div
										key={workspace.worktreePath}
										className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))]"
									>
										<div className="min-w-0">
											<div className="truncate font-medium">
												{workspace.worktreePath}
											</div>
											<div className="mt-1 text-xs text-muted-foreground">
												{workspace.latestStatus.hasPr
													? `PR #${workspace.latestStatus.prNumber ?? "?"} · checks ${workspace.latestStatus.checksStatus ?? "none"}`
													: "No attached PR"}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">State</div>
											<div className="mt-1 font-medium">
												{workspace.isActive ? "Active" : "Idle"}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">
												Status
											</div>
											<div className="mt-1 font-medium">
												{workspace.prStatusInFlight
													? "In flight"
													: workspace.nextPRStatusSyncAt
														? formatRelative(workspace.nextPRStatusSyncAt)
														: "Stopped"}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">
												Comments
											</div>
											<div className="mt-1 font-medium">
												{workspace.prCommentsInFlight
													? "In flight"
													: workspace.nextPRCommentsSyncAt
														? formatRelative(workspace.nextPRCommentsSyncAt)
														: "Stopped"}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">
												Last Status OK
											</div>
											<div className="mt-1 font-medium">
												{formatRelative(workspace.lastPRStatusSuccessAt)}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">
												Last Comments OK
											</div>
											<div className="mt-1 font-medium">
												{formatRelative(workspace.lastPRCommentsSuccessAt)}
											</div>
										</div>
									</div>
								))
							) : (
								<div className="px-4 py-6 text-sm text-muted-foreground">
									No GitHub workspaces have been registered yet.
								</div>
							)}
						</div>
					</div>
				</section>
			)}

			{isItemVisible(SETTING_ITEM_ID.METRICS_GITHUB_TRAFFIC, visibleItems) && (
				<section className="mt-10 space-y-4">
					<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
						GitHub Traffic
					</h3>

					<div className="grid gap-3 md:grid-cols-3">
						{(snapshot?.metrics.caches ?? []).map((cache) => (
							<div key={cache.kind} className="rounded-lg border p-4">
								<div className="text-xs uppercase tracking-wide text-muted-foreground">
									{cache.kind} cache
								</div>
								<div className="mt-2 text-lg font-semibold">
									{formatPercent(getCacheHitRatio(cache.rolling5m))}
								</div>
								<div className="mt-1 text-xs text-muted-foreground">
									5m hit ratio
								</div>
								<div className="mt-3 grid grid-cols-3 gap-2 text-xs">
									<div>
										<div className="text-muted-foreground">Hits</div>
										<div className="mt-1 font-medium">
											{cache.rolling5m.freshHits + cache.rolling5m.staleHits}
										</div>
									</div>
									<div>
										<div className="text-muted-foreground">Misses</div>
										<div className="mt-1 font-medium">
											{cache.rolling5m.misses}
										</div>
									</div>
									<div>
										<div className="text-muted-foreground">Writes</div>
										<div className="mt-1 font-medium">
											{cache.rolling5m.writes}
										</div>
									</div>
								</div>
							</div>
						))}
					</div>

					<div className="rounded-lg border overflow-hidden">
						<div className="border-b px-4 py-3">
							<h4 className="text-sm font-medium">Top Operations</h4>
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead className="bg-muted/30 text-muted-foreground">
									<tr>
										<th className="px-4 py-2 text-left font-medium">
											Operation
										</th>
										<th className="px-4 py-2 text-left font-medium">5m</th>
										<th className="px-4 py-2 text-left font-medium">Session</th>
										<th className="px-4 py-2 text-left font-medium">
											Failures
										</th>
										<th className="px-4 py-2 text-left font-medium">Avg</th>
										<th className="px-4 py-2 text-left font-medium">Last</th>
									</tr>
								</thead>
								<tbody>
									{topOperations.length > 0 ? (
										topOperations.map((operation) => (
											<tr
												key={`${operation.category}:${operation.name}`}
												className="border-t"
											>
												<td className="px-4 py-3 align-top">
													<div className="font-medium">{operation.name}</div>
													<div className="mt-1 text-xs text-muted-foreground">
														{operation.category}
														{operation.workspaces[0]
															? ` · top workspace ${operation.workspaces[0].worktreePath}`
															: ""}
													</div>
												</td>
												<td className="px-4 py-3">
													{operation.rolling5m.calls}
												</td>
												<td className="px-4 py-3">{operation.session.calls}</td>
												<td className="px-4 py-3">
													{operation.rolling5m.failures}
													{operation.rolling5m.rateLimited > 0
														? ` (${operation.rolling5m.rateLimited} rate-limited)`
														: ""}
												</td>
												<td className="px-4 py-3">
													{formatDuration(operation.rolling5m.avgDurationMs)}
												</td>
												<td className="px-4 py-3">
													<div>{formatRelative(operation.lastRunAt)}</div>
													{operation.lastErrorMessage ? (
														<div className="mt-1 max-w-[24rem] text-xs text-red-500 line-clamp-2">
															{operation.lastErrorMessage}
														</div>
													) : null}
												</td>
											</tr>
										))
									) : (
										<tr>
											<td
												colSpan={6}
												className="px-4 py-6 text-center text-muted-foreground"
											>
												No GitHub activity recorded yet.
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					</div>
				</section>
			)}

			{isItemVisible(SETTING_ITEM_ID.METRICS_GITHUB_COPY, visibleItems) && (
				<section className="mt-10 space-y-4">
					<h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
						Debug Copy
					</h3>
					<div className="grid gap-3 md:grid-cols-3">
						<Button variant="outline" onClick={() => void copySummary()}>
							<HiOutlineClipboardDocument className="mr-1.5 h-4 w-4" />
							Copy Summary
						</Button>
						<Button variant="outline" onClick={() => void copyDebugBundle()}>
							<HiOutlineClipboardDocument className="mr-1.5 h-4 w-4" />
							Copy Debug Bundle
						</Button>
						<Button variant="outline" onClick={() => void copyReproTemplate()}>
							<HiOutlineClipboardDocument className="mr-1.5 h-4 w-4" />
							Copy Repro Template
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						{copied
							? "Copied to clipboard."
							: "Use these buttons when debugging GitHub API usage or filing an issue."}
					</p>
				</section>
			)}
		</div>
	);
}
