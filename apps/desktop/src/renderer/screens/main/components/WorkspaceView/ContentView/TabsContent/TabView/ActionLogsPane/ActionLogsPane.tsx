import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { AnsiUp } from "ansi_up";
import { useCallback, useRef, useState } from "react";
import {
	LuCheck,
	LuChevronRight,
	LuCircleSlash,
	LuLoaderCircle,
	LuMinus,
	LuRefreshCw,
	LuSearch,
	LuSettings,
	LuX,
} from "react-icons/lu";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { ActionLogsJob } from "shared/tabs-types";
import { BasePaneWindow, PaneToolbarActions } from "../components";

// ── Status icon configs ──

const statusIcon = {
	success: { icon: LuCheck, className: "text-emerald-500" },
	failure: { icon: LuX, className: "text-red-500" },
	pending: { icon: LuLoaderCircle, className: "text-amber-500 animate-spin" },
	skipped: { icon: LuMinus, className: "text-muted-foreground" },
	cancelled: { icon: LuCircleSlash, className: "text-muted-foreground" },
} as const;

const stepStatusIcon = {
	success: statusIcon.success,
	failure: statusIcon.failure,
	cancelled: statusIcon.cancelled,
	skipped: statusIcon.skipped,
	in_progress: statusIcon.pending,
	queued: { icon: LuLoaderCircle, className: "text-muted-foreground" },
} as const;

function getStepIcon(status: string, conclusion: string | null) {
	if (status === "completed" && conclusion) {
		return (
			stepStatusIcon[conclusion as keyof typeof stepStatusIcon] ??
			stepStatusIcon.success
		);
	}
	return (
		stepStatusIcon[status as keyof typeof stepStatusIcon] ??
		stepStatusIcon.queued
	);
}

function formatDuration(seconds: number | null): string {
	if (seconds === null) return "";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ── ANSI rendering ──

const ansiUp = new AnsiUp();
ansiUp.use_classes = false;

function renderAnsiLine(line: string): string {
	// Strip ##[group], ##[endgroup], ##[command] etc. markers
	const cleaned = line.replace(
		/##\[(group|endgroup|command|error|warning|notice|debug)\]/g,
		"",
	);
	return ansiUp.ansi_to_html(cleaned);
}

function AnsiLine({ html, className }: { html: string; className?: string }) {
	return (
		// biome-ignore lint/security/noDangerouslySetInnerHtml: ansi_up escapes HTML entities
		<span className={className} dangerouslySetInnerHTML={{ __html: html }} />
	);
}

// ── Job steps component ──

interface JobStepsProps {
	workspaceId: string;
	detailsUrl: string;
	jobName: string;
	jobStatus: string;
	jobConclusion: string | null;
	showTimestamps: boolean;
	searchQuery: string;
}

function JobSteps({
	workspaceId,
	detailsUrl,
	jobName,
	jobStatus,
	jobConclusion,
	showTimestamps,
	searchQuery,
}: JobStepsProps) {
	const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
	const rerunMutation =
		electronTrpc.workspaces.rerunPullRequestChecks.useMutation();
	const trpcUtils = electronTrpc.useUtils();

	const { data: jobResult, isLoading } =
		electronTrpc.workspaces.getJobLogs.useQuery(
			{ workspaceId, detailsUrl },
			{
				staleTime: 3_000,
				refetchInterval: (query) => {
					const data = query.state.data;
					if (!data) return 3_000;
					return data.jobStatus === "completed" ? false : 3_000;
				},
			},
		);

	const steps = jobResult?.steps ?? [];
	const liveJobStatus = jobResult?.jobStatus ?? jobStatus;
	const liveJobConclusion = jobResult?.jobConclusion ?? jobConclusion;

	const toggleStep = (n: number) => {
		setExpandedSteps((prev) => {
			const next = new Set(prev);
			next.has(n) ? next.delete(n) : next.add(n);
			return next;
		});
	};

	const handleRerun = async (mode: "all" | "failed") => {
		try {
			const result = await rerunMutation.mutateAsync({
				workspaceId,
				mode,
			});
			toast.success(
				`Re-running ${mode === "failed" ? "failed" : "all"} jobs (${result.rerunCount})`,
			);
			void trpcUtils.workspaces.getJobLogs.invalidate();
			void trpcUtils.workspaces.getGitHubStatus.invalidate();
		} catch {
			toast.error("Failed to re-run jobs");
		}
	};

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
				<LuLoaderCircle className="size-4 animate-spin" />
				Loading logs...
			</div>
		);
	}

	if (!steps || steps.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
				No logs available
			</div>
		);
	}

	const totalSeconds = steps.reduce(
		(sum, s) => sum + (s.durationSeconds ?? 0),
		0,
	);
	// jobStatus is already in check format (success/failure/pending/etc) or job API format
	const resolvedStatus =
		liveJobStatus === "completed"
			? liveJobConclusion === "success"
				? "success"
				: liveJobConclusion === "cancelled"
					? "cancelled"
					: "failure"
			: liveJobStatus === "in_progress" || liveJobStatus === "pending"
				? "pending"
				: (liveJobStatus as keyof typeof statusIcon);
	const { icon: JobIcon, className: jobIconClass } =
		statusIcon[resolvedStatus as keyof typeof statusIcon] ?? statusIcon.pending;

	const lowerQuery = searchQuery.toLowerCase();

	return (
		<div className="h-full overflow-auto">
			{/* Job header */}
			<div className="flex items-center justify-between border-b border-border px-4 py-3">
				<div>
					<div className="flex items-center gap-2">
						<JobIcon className={cn("size-4 shrink-0", jobIconClass)} />
						<span className="text-sm font-medium text-primary">{jobName}</span>
					</div>
					{totalSeconds > 0 && (
						<p className="mt-0.5 pl-6 text-xs text-muted-foreground">
							{formatDuration(totalSeconds)}
						</p>
					)}
				</div>
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-6 px-2 text-[10px]"
						disabled={rerunMutation.isPending}
						onClick={() => void handleRerun("failed")}
					>
						<LuRefreshCw
							className={cn(
								"mr-1 size-3",
								rerunMutation.isPending && "animate-spin",
							)}
						/>
						Re-run failed
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-6 px-2 text-[10px]"
						disabled={rerunMutation.isPending}
						onClick={() => void handleRerun("all")}
					>
						<LuRefreshCw
							className={cn(
								"mr-1 size-3",
								rerunMutation.isPending && "animate-spin",
							)}
						/>
						Re-run all
					</Button>
				</div>
			</div>

			{/* Steps */}
			{steps.map((step) => {
				const isExpanded = expandedSteps.has(step.number);
				const { icon: StepIcon, className: iconClass } = getStepIcon(
					step.status,
					step.conclusion,
				);
				const rawLines = step.logs ? step.logs.split("\n") : [];

				// Filter lines by search query
				const filteredLines =
					lowerQuery && rawLines.length > 0
						? rawLines.filter((l) => l.toLowerCase().includes(lowerQuery))
						: rawLines;

				const matchesSearch =
					!lowerQuery ||
					step.name.toLowerCase().includes(lowerQuery) ||
					filteredLines.length > 0;

				if (!matchesSearch) return null;

				return (
					<div key={step.number}>
						<button
							type="button"
							className={cn(
								"flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/50",
								isExpanded && "bg-accent/30",
							)}
							onClick={() => toggleStep(step.number)}
						>
							<LuChevronRight
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground transition-transform",
									isExpanded && "rotate-90",
								)}
							/>
							<StepIcon className={cn("size-4 shrink-0", iconClass)} />
							<span className="min-w-0 flex-1 truncate">{step.name}</span>
							{step.durationSeconds !== null && (
								<span className="shrink-0 text-xs text-muted-foreground">
									{formatDuration(step.durationSeconds)}
								</span>
							)}
						</button>
						{isExpanded && filteredLines.length > 0 && (
							<div className="border-b border-border bg-[hsl(var(--background))]/50">
								<pre className="overflow-x-auto p-0 font-mono text-[11px] leading-[1.6]">
									{filteredLines.map((line, i) => {
										// Parse timestamp from original line if showTimestamps
										const tsMatch = showTimestamps
											? line.match(
													/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/,
												)
											: null;
										const displayLine = tsMatch
											? line
											: line.replace(
													/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/,
													"",
												);

										return (
											// biome-ignore lint/suspicious/noArrayIndexKey: log lines are static read-only content
											<div key={i} className="flex hover:bg-accent/30">
												<span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/50">
													{i + 1}
												</span>
												<AnsiLine
													className="min-w-0 whitespace-pre-wrap break-all pr-3"
													html={renderAnsiLine(displayLine)}
												/>
											</div>
										);
									})}
								</pre>
							</div>
						)}
						{isExpanded && filteredLines.length === 0 && (
							<div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
								{lowerQuery ? "No matching lines" : "No log output"}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ── Main pane ──

interface ActionLogsPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
}

export function ActionLogsPane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: ActionLogsPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const initialJobs: ActionLogsJob[] = pane?.actionLogs?.jobs ?? [];
	const initialIndex = pane?.actionLogs?.initialJobIndex ?? 0;
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);
	const [showTimestamps, setShowTimestamps] = useState(false);

	// Read check statuses from the shared getGitHubStatus cache (same source as Review tab)
	const { data: githubStatus } =
		electronTrpc.workspaces.getGitHubStatus.useQuery(
			{ workspaceId },
			{ staleTime: 3_000, refetchInterval: 3_000 },
		);
	const checks = githubStatus?.pr?.checks ?? [];

	// Build live job list: match by name to track across re-runs (URLs change on re-run)
	const jobs: ActionLogsJob[] = initialJobs.map((job) => {
		const liveCheck = checks.find((c) => c.name === job.name);
		if (liveCheck) {
			return {
				detailsUrl: liveCheck.url ?? job.detailsUrl,
				name: liveCheck.name ?? job.name,
				status: liveCheck.status,
			};
		}
		return job;
	});

	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [sidebarWidth, setSidebarWidth] = useState(208);
	const isDragging = useRef(false);
	const selectedJob = jobs[selectedIndex];

	const browserUrl = selectedJob?.detailsUrl?.match(
		/(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+)/,
	)?.[1];

	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isDragging.current = true;
			const startX = e.clientX;
			const startWidth = sidebarWidth;

			const onMouseMove = (ev: MouseEvent) => {
				const newWidth = Math.min(
					400,
					Math.max(120, startWidth + ev.clientX - startX),
				);
				setSidebarWidth(newWidth);
			};
			const onMouseUp = () => {
				isDragging.current = false;
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
			};
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[sidebarWidth],
	);

	const handleToggleSearch = useCallback(() => {
		setSearchOpen((prev) => {
			if (!prev) {
				setTimeout(() => searchInputRef.current?.focus(), 0);
			} else {
				setSearchQuery("");
			}
			return !prev;
		});
	}, []);

	// Get raw logs URL for "View raw logs"
	const rawLogsUrl = browserUrl ? `${browserUrl}?pr=` : undefined;

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center gap-2 px-2">
					<span className="truncate text-sm text-muted-foreground">
						Action Logs
					</span>

					<div className="ml-auto flex items-center gap-1">
						{/* Search */}
						{searchOpen && (
							<div className="flex items-center gap-1 rounded-sm border border-border bg-background px-1.5">
								<LuSearch className="size-3 text-muted-foreground" />
								<input
									ref={searchInputRef}
									type="text"
									placeholder="Search logs"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									className="h-5 w-36 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
									onKeyDown={(e) => {
										if (e.key === "Escape") {
											handleToggleSearch();
										}
									}}
								/>
								{searchQuery && (
									<button
										type="button"
										onClick={() => setSearchQuery("")}
										className="text-muted-foreground hover:text-foreground"
									>
										<LuX className="size-3" />
									</button>
								)}
							</div>
						)}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="size-6 p-0"
							onClick={handleToggleSearch}
							title="Search logs"
						>
							<LuSearch className="size-3.5" />
						</Button>

						{/* Settings dropdown */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="size-6 p-0"
								>
									<LuSettings className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-48">
								<DropdownMenuItem onClick={() => setShowTimestamps((p) => !p)}>
									{showTimestamps ? "Hide" : "Show"} timestamps
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								{browserUrl && (
									<DropdownMenuItem asChild>
										<a
											href={browserUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											View on GitHub
										</a>
									</DropdownMenuItem>
								)}
								{rawLogsUrl && (
									<DropdownMenuItem asChild>
										<a
											href={rawLogsUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											View raw logs
										</a>
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>

						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							onPopOut={handlers.onPopOut}
						/>
					</div>
				</div>
			)}
		>
			{jobs.length === 0 ? (
				<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
					No jobs configured
				</div>
			) : (
				<div className="flex h-full">
					{/* Job sidebar */}
					<div
						className="relative flex shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/30"
						style={{ width: sidebarWidth }}
					>
						<div className="px-3 py-2 text-xs font-medium text-muted-foreground">
							All jobs
						</div>
						{jobs.map((job, i) => {
							const { icon: JobIcon, className: jobIconClass } =
								statusIcon[job.status as keyof typeof statusIcon] ??
								statusIcon.pending;
							return (
								<button
									key={job.detailsUrl}
									type="button"
									className={cn(
										"flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/50",
										i === selectedIndex
											? "border-l-primary bg-accent/40"
											: "border-l-transparent",
									)}
									onClick={() => setSelectedIndex(i)}
								>
									<JobIcon className={cn("size-3.5 shrink-0", jobIconClass)} />
									<span className="min-w-0 truncate">{job.name}</span>
								</button>
							);
						})}
						{/* Resize handle */}
						<button
							type="button"
							aria-label="Resize sidebar"
							className="absolute right-0 top-0 h-full w-1 cursor-col-resize border-none bg-transparent p-0 hover:bg-primary/30 active:bg-primary/50"
							onMouseDown={handleResizeStart}
						/>
					</div>
					{/* Step detail */}
					<div className="min-w-0 flex-1">
						{selectedJob && (
							<JobSteps
								key={selectedJob.detailsUrl}
								workspaceId={workspaceId}
								detailsUrl={selectedJob.detailsUrl}
								jobName={selectedJob.name}
								jobStatus={selectedJob.status}
								jobConclusion={null}
								showTimestamps={showTimestamps}
								searchQuery={searchQuery}
							/>
						)}
					</div>
				</div>
			)}
		</BasePaneWindow>
	);
}
