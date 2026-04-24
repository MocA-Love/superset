import { Avatar } from "@superset/ui/atoms/Avatar";
import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@superset/ui/command";
import { Input } from "@superset/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Skeleton } from "@superset/ui/skeleton";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import type { ClipboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
	LuArrowUpRight,
	LuCheck,
	LuChevronDown,
	LuFilePlus2,
	LuGitPullRequest,
	LuImage,
	LuLoaderCircle,
	LuPlay,
	LuTag,
	LuUserPlus,
	LuWorkflow,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { showGitConfirmDialog } from "renderer/lib/git/gitConfirmDialog";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useTabsStore } from "renderer/stores/tabs/store";

function formatRepositoryTimestamp(value: string | null): string {
	if (!value) {
		return "";
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	return new Intl.DateTimeFormat("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

interface RepositoryPanelProps {
	isActive?: boolean;
}

interface UploadedIssueAsset {
	id: string;
	name: string;
	url: string;
	markdown: string;
}

interface TrackedWorkflowRun {
	workflowId: number;
	workflowName: string;
	ref: string;
	dispatchedAt: string;
}

interface WorkflowRunSummary {
	id: number;
	status: string;
	conclusion: string | null;
	createdAt: string | null;
	headBranch: string | null;
	runStartedAt?: string | null;
	runNumber?: number | null;
	url?: string | null;
}

function buildSelectionSummary(items: string[], emptyLabel: string): string {
	if (items.length === 0) {
		return emptyLabel;
	}

	if (items.length <= 2) {
		return items.join(", ");
	}

	return `${items.slice(0, 2).join(", ")} +${items.length - 2}`;
}

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("Failed to read image"));
				return;
			}
			const commaIndex = result.indexOf(",");
			resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read image"));
		reader.readAsDataURL(file);
	});
}

function getWorkflowRunStatusLabel(
	run?: {
		status: string;
		conclusion: string | null;
	} | null,
): string {
	if (!run) {
		return "Waiting";
	}

	if (run.status === "completed") {
		switch (run.conclusion) {
			case "success":
				return "Succeeded";
			case "failure":
				return "Failed";
			case "cancelled":
				return "Cancelled";
			case "skipped":
				return "Skipped";
			default:
				return run.conclusion ?? "Completed";
		}
	}

	if (run.status === "in_progress") {
		return "Running";
	}

	if (run.status === "queued") {
		return "Queued";
	}

	return run.status;
}

function getWorkflowRunStatusClassName(
	run?: {
		status: string;
		conclusion: string | null;
	} | null,
): string {
	if (!run) {
		return "border-border/60 text-muted-foreground";
	}

	if (run.status !== "completed") {
		return "border-blue-500/30 text-blue-600 dark:text-blue-300";
	}

	switch (run.conclusion) {
		case "success":
			return "border-emerald-500/30 text-emerald-600 dark:text-emerald-300";
		case "failure":
			return "border-red-500/30 text-red-600 dark:text-red-300";
		case "cancelled":
			return "border-amber-500/30 text-amber-600 dark:text-amber-300";
		default:
			return "border-border/60 text-muted-foreground";
	}
}

function findTrackedWorkflowRun(
	runs: WorkflowRunSummary[],
	tracked: TrackedWorkflowRun,
) {
	const dispatchedAtMs = Date.parse(tracked.dispatchedAt);
	return runs.find((run) => {
		const createdAtMs = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
		if (Number.isNaN(createdAtMs) || createdAtMs < dispatchedAtMs - 30_000) {
			return false;
		}

		return !run.headBranch || run.headBranch === tracked.ref;
	});
}

function WorkflowRunCard({
	workspaceId,
	tracked,
	onOpenUrl,
	onRemove,
	onViewLogs,
}: {
	workspaceId: string;
	tracked: TrackedWorkflowRun;
	onOpenUrl: (url: string) => void;
	onRemove: (workflowId: number) => void;
	onViewLogs: (runId: number) => void;
}) {
	const { data: runs = [], isFetching } =
		electronTrpc.workspaces.githubExtended.getGitHubWorkflowRuns.useQuery(
			{
				workspaceId,
				workflowId: tracked.workflowId,
			},
			{
				refetchInterval: (query) => {
					const matched = findTrackedWorkflowRun(
						query.state.data ?? [],
						tracked,
					);
					return matched?.status === "completed" ? false : 3_000;
				},
				refetchIntervalInBackground: true,
				staleTime: 0,
			},
		);

	const matchedRun = findTrackedWorkflowRun(runs, tracked);
	const statusLabel = getWorkflowRunStatusLabel(matchedRun);
	const statusClassName = getWorkflowRunStatusClassName(matchedRun);
	const isPending =
		!matchedRun ||
		matchedRun.status === "queued" ||
		matchedRun.status === "in_progress";
	const timestampLabel = formatRepositoryTimestamp(
		matchedRun?.runStartedAt ?? matchedRun?.createdAt ?? tracked.dispatchedAt,
	);

	return (
		<div className="rounded-sm border border-border/60 bg-background px-2 py-2">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<p className="truncate text-xs font-medium text-foreground">
						{tracked.workflowName}
					</p>
					<p className="truncate text-[11px] text-muted-foreground">
						{matchedRun?.runNumber ? `#${matchedRun.runNumber} · ` : ""}
						{tracked.ref}
					</p>
				</div>
				<div className="flex items-center gap-1">
					<Badge variant="outline" className={statusClassName}>
						{isPending ? (
							<LuLoaderCircle className="mr-1 size-3 animate-spin" />
						) : null}
						{statusLabel}
					</Badge>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-1.5 text-[10px]"
								onClick={() => onRemove(tracked.workflowId)}
							>
								<LuX className="size-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top" showArrow={false}>
							Stop tracking workflow
						</TooltipContent>
					</Tooltip>
				</div>
			</div>
			<div className="mt-2 flex items-center justify-between gap-2">
				<p className="truncate text-[11px] text-muted-foreground">
					{matchedRun
						? timestampLabel
							? `${isPending ? "Updated" : "Finished"} ${timestampLabel}`
							: statusLabel
						: isFetching
							? "Waiting for GitHub to create the run..."
							: "Looking for the triggered run..."}
				</p>
				<div className="flex items-center gap-1">
					{matchedRun?.id ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-[10px]"
							onClick={() => {
								if (matchedRun.id) {
									onViewLogs(matchedRun.id);
								}
							}}
						>
							<LuWorkflow className="mr-1 size-3" />
							View logs
						</Button>
					) : null}
					{matchedRun?.url ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-[10px]"
							onClick={() => {
								if (matchedRun.url) {
									onOpenUrl(matchedRun.url);
								}
							}}
						>
							<LuArrowUpRight className="mr-1 size-3" />
							GitHub
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}

export function RepositoryPanel({ isActive = true }: RepositoryPanelProps) {
	const workspaceId = useWorkspaceId();
	const trpcUtils = electronTrpc.useUtils();
	const addBrowserTab = useTabsStore((state) => state.addBrowserTab);
	const addActionLogsTab = useTabsStore((state) => state.addActionLogsTab);
	const [open, setOpen] = useState(false);
	const [pullRequestsOpen, setPullRequestsOpen] = useState(true);
	const [workflowsOpen, setWorkflowsOpen] = useState(true);
	const [issueComposerOpen, setIssueComposerOpen] = useState(false);
	const [issueTitle, setIssueTitle] = useState("");
	const [issueBody, setIssueBody] = useState("");
	const [issueAssignees, setIssueAssignees] = useState<string[]>([]);
	const [issueLabels, setIssueLabels] = useState<string[]>([]);
	const [issueAssigneeSearch, setIssueAssigneeSearch] = useState("");
	const [issueLabelSearch, setIssueLabelSearch] = useState("");
	const [openIssuePicker, setOpenIssuePicker] = useState<
		"assignees" | "labels" | null
	>(null);
	const [uploadedAssets, setUploadedAssets] = useState<UploadedIssueAsset[]>(
		[],
	);
	const [isUploadingAsset, setIsUploadingAsset] = useState(false);
	const [workflowRef, setWorkflowRef] = useState("");
	const [pendingWorkflowId, setPendingWorkflowId] = useState<number | null>(
		null,
	);
	const [expandedWorkflowId, setExpandedWorkflowId] = useState<number | null>(
		null,
	);
	const [workflowInputValues, setWorkflowInputValues] = useState<
		Record<number, Record<string, string>>
	>({});
	const [trackedWorkflowRuns, setTrackedWorkflowRuns] = useState<
		TrackedWorkflowRun[]
	>([]);
	const {
		data: repositoryOverview,
		isLoading,
		error,
	} = electronTrpc.workspaces.githubExtended.getGitHubRepositoryOverview.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: !!workspaceId && isActive,
			staleTime: 300_000,
			refetchOnWindowFocus: isActive,
		},
	);
	const createIssueMutation =
		electronTrpc.workspaces.githubExtended.createGitHubIssue.useMutation();
	const uploadIssueAssetMutation =
		electronTrpc.workspaces.githubExtended.uploadGitHubIssueAsset.useMutation();
	const dispatchWorkflowMutation =
		electronTrpc.workspaces.githubExtended.dispatchGitHubWorkflow.useMutation();

	const availableAssignees = repositoryOverview?.issueAssignees ?? [];
	const availableAssigneesByLogin = useMemo(
		() =>
			new Map(
				availableAssignees.map(
					(assignee) => [assignee.login, assignee] as const,
				),
			),
		[availableAssignees],
	);
	const availableLabels = repositoryOverview?.issueLabels ?? [];
	const filteredAssignees = useMemo(() => {
		const query = issueAssigneeSearch.trim().toLowerCase();
		return availableAssignees.filter((candidate) => {
			if (issueAssignees.includes(candidate.login)) {
				return false;
			}

			return query ? candidate.login.toLowerCase().includes(query) : true;
		});
	}, [availableAssignees, issueAssigneeSearch, issueAssignees]);
	const filteredLabels = useMemo(() => {
		const query = issueLabelSearch.trim().toLowerCase();
		return availableLabels.filter((candidate) => {
			if (issueLabels.includes(candidate.name)) {
				return false;
			}

			return query
				? candidate.name.toLowerCase().includes(query) ||
						candidate.description.toLowerCase().includes(query)
				: true;
		});
	}, [availableLabels, issueLabelSearch, issueLabels]);

	useEffect(() => {
		if (!repositoryOverview) {
			return;
		}

		setWorkflowRef((current) =>
			current.trim()
				? current
				: repositoryOverview.branchExistsOnRemote
					? repositoryOverview.currentBranch || repositoryOverview.defaultBranch
					: repositoryOverview.defaultBranch,
		);
	}, [
		repositoryOverview?.branchExistsOnRemote,
		repositoryOverview?.currentBranch,
		repositoryOverview?.defaultBranch,
		repositoryOverview,
	]);

	useEffect(() => {
		if (!issueComposerOpen) {
			setOpenIssuePicker(null);
			setIssueAssigneeSearch("");
			setIssueLabelSearch("");
		}
	}, [issueComposerOpen]);

	useEffect(() => {
		if (workspaceId === undefined) {
			setTrackedWorkflowRuns([]);
			return;
		}

		setTrackedWorkflowRuns([]);
	}, [workspaceId]);

	const openUrl = (url: string) => {
		if (!workspaceId) {
			return;
		}

		addBrowserTab(workspaceId, url);
	};

	const invalidateOverview = async () => {
		if (!workspaceId) {
			return;
		}

		await trpcUtils.workspaces.githubExtended.getGitHubRepositoryOverview.invalidate(
			{
				workspaceId,
			},
		);
	};

	const handleCreateIssue = async () => {
		if (!workspaceId || !issueTitle.trim()) {
			return;
		}

		try {
			const result = await createIssueMutation.mutateAsync({
				workspaceId,
				title: issueTitle.trim(),
				body: issueBody.trim() || undefined,
				assignees: issueAssignees,
				labels: issueLabels,
			});
			setIssueTitle("");
			setIssueBody("");
			setIssueAssignees([]);
			setIssueLabels([]);
			setUploadedAssets([]);
			setIssueComposerOpen(false);
			toast.success("Issue created");
			if (result.url) {
				openUrl(result.url);
			}
			await invalidateOverview();
		} catch (mutationError) {
			const message =
				mutationError instanceof Error
					? mutationError.message
					: "Unknown error";
			toast.error(`Failed to create issue: ${message}`);
		}
	};

	const handleTextareaPaste = async (
		event: ClipboardEvent<HTMLTextAreaElement>,
	) => {
		const files = Array.from(event.clipboardData?.items ?? [])
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file): file is File => Boolean(file))
			.filter((file) => file.type.startsWith("image/"));

		if (files.length === 0 || !workspaceId) {
			return;
		}

		event.preventDefault();
		setIsUploadingAsset(true);
		try {
			const uploaded: UploadedIssueAsset[] = [];
			for (const file of files) {
				const contentBase64 = await readFileAsBase64(file);
				const result = await uploadIssueAssetMutation.mutateAsync({
					workspaceId,
					filename: file.name || `pasted-image-${Date.now()}.png`,
					contentBase64,
					mimeType: file.type || undefined,
				});
				uploaded.push({
					id: crypto.randomUUID(),
					name: result.name,
					url: result.url,
					markdown: result.markdown,
				});
			}

			setUploadedAssets((current) => [...current, ...uploaded]);
			setIssueBody((current) => {
				const prefix = current.trimEnd();
				const markdown = uploaded.map((asset) => asset.markdown).join("\n");
				return prefix ? `${prefix}\n\n${markdown}` : markdown;
			});
			toast.success(
				uploaded.length === 1
					? "Image attached to issue draft"
					: `${uploaded.length} images attached to issue draft`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to attach image: ${message}`);
		} finally {
			setIsUploadingAsset(false);
		}
	};

	const removeUploadedAsset = (assetId: string) => {
		const asset = uploadedAssets.find((item) => item.id === assetId);
		if (!asset) {
			return;
		}

		setUploadedAssets((current) =>
			current.filter((item) => item.id !== assetId),
		);
		setIssueBody((current) => {
			const next = current
				.replace(asset.markdown, "")
				.replace(/\n{3,}/g, "\n\n");
			return next.trim();
		});
	};

	const handleRunWorkflow = async (
		workflowId: number,
		workflowName: string,
		workflowInputDefs?: Array<{
			name: string;
			required: boolean;
		}>,
	) => {
		if (!workspaceId) {
			return;
		}

		const rawInputs = workflowInputValues[workflowId];

		// Validate required inputs
		if (workflowInputDefs && rawInputs) {
			const missing = workflowInputDefs.filter(
				(def) => def.required && !rawInputs[def.name]?.trim(),
			);
			if (missing.length > 0) {
				toast.error(`Required: ${missing.map((m) => m.name).join(", ")}`);
				return;
			}
		}

		// Strip empty values
		let filteredInputs: Record<string, string> | undefined;
		if (rawInputs) {
			const cleaned = Object.fromEntries(
				Object.entries(rawInputs).filter(([, v]) => v !== ""),
			);
			filteredInputs = Object.keys(cleaned).length > 0 ? cleaned : undefined;
		}

		const runDispatch = async () => {
			setPendingWorkflowId(workflowId);
			try {
				const result = await dispatchWorkflowMutation.mutateAsync({
					workspaceId,
					workflowId,
					ref: workflowRef.trim() || undefined,
					inputs: filteredInputs,
				});
				setTrackedWorkflowRuns((current) =>
					[
						{
							workflowId,
							workflowName,
							ref: result.ref,
							dispatchedAt: result.dispatchedAt,
						},
						...current.filter((item) => item.workflowId !== workflowId),
					].slice(0, 4),
				);
				toast.success(`Triggered ${workflowName} on ${result.ref}`);
			} catch (mutationError) {
				const message =
					mutationError instanceof Error
						? mutationError.message
						: "Unknown error";
				toast.error(`Failed to run workflow: ${message}`);
			} finally {
				setPendingWorkflowId((current) =>
					current === workflowId ? null : current,
				);
			}
		};

		showGitConfirmDialog({
			kind: "workflow-dispatch-confirm",
			tone: "warn",
			title: `GitHub Actions ワークフローを実行しますか?`,
			description: `${workflowName} を ${workflowRef.trim() || "デフォルトブランチ"} で手動起動します。remote 副作用のあるワークフローは特に注意してください。`,
			confirmLabel: "実行",
			confirmVariant: "primary",
			onConfirm: () => {
				void runDispatch();
			},
		});
	};

	const handleViewWorkflowLogs = async (runId: number) => {
		if (!workspaceId) {
			return;
		}
		try {
			const jobs =
				await trpcUtils.workspaces.githubExtended.getWorkflowRunJobs.fetch({
					workspaceId,
					runId,
				});
			const failedIdx = jobs.findIndex((j) => j.status === "failure");
			addActionLogsTab(
				workspaceId,
				jobs,
				failedIdx >= 0 ? failedIdx : undefined,
				runId,
			);
		} catch {
			toast.error("Failed to fetch workflow jobs");
		}
	};

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger
				className={cn(
					"flex h-8 w-full items-center justify-between gap-2 border-b bg-background px-3 text-left text-xs font-medium text-foreground",
					"transition-colors hover:bg-accent/30",
				)}
			>
				<div className="flex min-w-0 items-center gap-2">
					<LuChevronDown
						className={cn(
							"size-3 shrink-0 text-muted-foreground transition-transform duration-150",
							!open && "-rotate-90",
						)}
					/>
					<span>Repository</span>
					{repositoryOverview?.repositoryNameWithOwner ? (
						<span className="truncate text-[11px] font-normal text-muted-foreground">
							{repositoryOverview.repositoryNameWithOwner}
						</span>
					) : null}
				</div>
				{isLoading ? (
					<LuLoaderCircle className="size-3 animate-spin text-muted-foreground" />
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent className="overflow-hidden border-b bg-background">
				<div className="space-y-3 px-3 py-3">
					{isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-8 w-full" />
							<Skeleton className="h-16 w-full" />
						</div>
					) : error || !repositoryOverview ? (
						<div className="rounded-sm border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
							GitHub repository is not available for this workspace.
						</div>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-foreground">
										{repositoryOverview.repositoryNameWithOwner}
									</p>
									<p className="truncate text-[11px] text-muted-foreground">
										Branch {repositoryOverview.currentBranch}
									</p>
									{repositoryOverview.isFork ? (
										<p className="truncate text-[11px] text-muted-foreground">
											Upstream {repositoryOverview.upstreamNameWithOwner}
										</p>
									) : null}
								</div>
								{repositoryOverview.isFork ? (
									<Badge variant="secondary">Fork</Badge>
								) : null}
								<Badge variant="outline">
									Default {repositoryOverview.defaultBranch}
								</Badge>
							</div>

							<div className="grid grid-cols-2 gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="justify-start gap-1.5"
									onClick={() => openUrl(repositoryOverview.repositoryUrl)}
								>
									<LuArrowUpRight className="size-3.5" />
									Repo
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="justify-start gap-1.5"
									onClick={() => openUrl(repositoryOverview.pullsUrl)}
								>
									<LuGitPullRequest className="size-3.5" />
									Pull Requests
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="justify-start gap-1.5"
									onClick={() => openUrl(repositoryOverview.issuesUrl)}
								>
									<LuFilePlus2 className="size-3.5" />
									Issues
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="justify-start gap-1.5"
									onClick={() => openUrl(repositoryOverview.actionsUrl)}
								>
									<LuWorkflow className="size-3.5" />
									Actions
								</Button>
							</div>

							<div className="space-y-2 rounded-sm border border-border/60 bg-muted/10 p-2">
								<div className="flex items-center justify-between gap-2">
									<p className="text-xs font-medium text-foreground">
										New Issue
									</p>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-[11px]"
										onClick={() => setIssueComposerOpen((current) => !current)}
									>
										{issueComposerOpen ? "Hide" : "Compose"}
									</Button>
								</div>
								{issueComposerOpen ? (
									<div className="space-y-2">
										<Input
											value={issueTitle}
											onChange={(event) => setIssueTitle(event.target.value)}
											placeholder="Issue title"
										/>
										<div className="grid grid-cols-2 gap-2">
											<Popover
												open={openIssuePicker === "assignees"}
												onOpenChange={(nextOpen) => {
													setOpenIssuePicker(nextOpen ? "assignees" : null);
													if (!nextOpen) {
														setIssueAssigneeSearch("");
													}
												}}
											>
												<PopoverTrigger asChild>
													<button
														type="button"
														className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-background px-3 text-left text-xs transition-colors hover:bg-accent/30"
													>
														<LuUserPlus className="size-3.5 shrink-0 text-muted-foreground" />
														<span className="truncate">
															{buildSelectionSummary(
																issueAssignees,
																"Assignees",
															)}
														</span>
														<LuChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
													</button>
												</PopoverTrigger>
												<PopoverContent align="start" className="w-72 p-0">
													<Command shouldFilter={false}>
														<CommandInput
															placeholder="Search assignees..."
															value={issueAssigneeSearch}
															onValueChange={setIssueAssigneeSearch}
														/>
														<CommandList className="max-h-64">
															{issueAssignees.length > 0 ? (
																<CommandGroup heading="Selected">
																	{issueAssignees.map((assignee) => (
																		<CommandItem
																			key={`selected-assignee-${assignee}`}
																			onSelect={() =>
																				setIssueAssignees((current) =>
																					current.filter(
																						(item) => item !== assignee,
																					),
																				)
																			}
																		>
																			<Avatar
																				size="xs"
																				fullName={assignee}
																				image={
																					availableAssigneesByLogin.get(
																						assignee,
																					)?.avatarUrl
																				}
																			/>
																			<LuCheck className="size-3.5 text-primary" />
																			<span className="flex-1 truncate">
																				{assignee}
																			</span>
																			<LuX className="size-3.5 text-muted-foreground" />
																		</CommandItem>
																	))}
																</CommandGroup>
															) : null}
															{filteredAssignees.length === 0 ? (
																<CommandEmpty>No assignees found.</CommandEmpty>
															) : (
																<CommandGroup heading="Available">
																	{filteredAssignees.map((assignee) => (
																		<CommandItem
																			key={assignee.login}
																			onSelect={() =>
																				setIssueAssignees((current) => [
																					...current,
																					assignee.login,
																				])
																			}
																		>
																			<Avatar
																				size="xs"
																				fullName={assignee.login}
																				image={assignee.avatarUrl}
																			/>
																			<span className="truncate">
																				{assignee.login}
																			</span>
																		</CommandItem>
																	))}
																</CommandGroup>
															)}
														</CommandList>
													</Command>
												</PopoverContent>
											</Popover>
											<Popover
												open={openIssuePicker === "labels"}
												onOpenChange={(nextOpen) => {
													setOpenIssuePicker(nextOpen ? "labels" : null);
													if (!nextOpen) {
														setIssueLabelSearch("");
													}
												}}
											>
												<PopoverTrigger asChild>
													<button
														type="button"
														className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-background px-3 text-left text-xs transition-colors hover:bg-accent/30"
													>
														<LuTag className="size-3.5 shrink-0 text-muted-foreground" />
														<span className="truncate">
															{buildSelectionSummary(issueLabels, "Labels")}
														</span>
														<LuChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
													</button>
												</PopoverTrigger>
												<PopoverContent align="start" className="w-72 p-0">
													<Command shouldFilter={false}>
														<CommandInput
															placeholder="Search labels..."
															value={issueLabelSearch}
															onValueChange={setIssueLabelSearch}
														/>
														<CommandList className="max-h-64">
															{issueLabels.length > 0 ? (
																<CommandGroup heading="Selected">
																	{issueLabels.map((label) => (
																		<CommandItem
																			key={`selected-label-${label}`}
																			onSelect={() =>
																				setIssueLabels((current) =>
																					current.filter(
																						(item) => item !== label,
																					),
																				)
																			}
																		>
																			<LuCheck className="size-3.5 text-primary" />
																			<span className="flex-1 truncate">
																				{label}
																			</span>
																			<LuX className="size-3.5 text-muted-foreground" />
																		</CommandItem>
																	))}
																</CommandGroup>
															) : null}
															{filteredLabels.length === 0 ? (
																<CommandEmpty>No labels found.</CommandEmpty>
															) : (
																<CommandGroup heading="Available">
																	{filteredLabels.map((label) => (
																		<CommandItem
																			key={label.name}
																			onSelect={() =>
																				setIssueLabels((current) => [
																					...current,
																					label.name,
																				])
																			}
																		>
																			<span
																				className="size-2.5 rounded-full"
																				style={{
																					backgroundColor: `#${label.color}`,
																				}}
																			/>
																			<div className="flex min-w-0 flex-1 flex-col">
																				<span className="truncate">
																					{label.name}
																				</span>
																				{label.description ? (
																					<span className="truncate text-[11px] text-muted-foreground">
																						{label.description}
																					</span>
																				) : null}
																			</div>
																		</CommandItem>
																	))}
																</CommandGroup>
															)}
														</CommandList>
													</Command>
												</PopoverContent>
											</Popover>
										</div>
										{issueAssignees.length > 0 || issueLabels.length > 0 ? (
											<div className="flex flex-wrap gap-1">
												{issueAssignees.map((assignee) => (
													<Badge
														key={`assignee-badge-${assignee}`}
														variant="outline"
														className="gap-1"
													>
														<Avatar
															size="xs"
															fullName={assignee}
															image={
																availableAssigneesByLogin.get(assignee)
																	?.avatarUrl
															}
														/>
														{assignee}
													</Badge>
												))}
												{issueLabels.map((label) => (
													<Badge
														key={`label-badge-${label}`}
														variant="secondary"
														className="gap-1"
													>
														<LuTag className="size-3" />
														{label}
													</Badge>
												))}
											</div>
										) : null}
										<Textarea
											value={issueBody}
											onChange={(event) => setIssueBody(event.target.value)}
											onPaste={(event) => {
												void handleTextareaPaste(event);
											}}
											placeholder="Issue description. Paste images from clipboard to attach."
											className="min-h-20 resize-y"
										/>
										{isUploadingAsset ? (
											<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
												<LuLoaderCircle className="size-3 animate-spin" />
												Uploading pasted image...
											</div>
										) : null}
										{uploadedAssets.length > 0 ? (
											<div className="space-y-1 rounded-sm border border-border/60 bg-background px-2 py-2">
												<div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
													<LuImage className="size-3.5" />
													Attached Images
												</div>
												<div className="space-y-1">
													{uploadedAssets.map((asset) => (
														<div
															key={asset.id}
															className="flex items-center justify-between gap-2 rounded-sm border border-border/50 px-2 py-1"
														>
															<button
																type="button"
																className="min-w-0 flex-1 truncate text-left text-[11px] text-foreground transition-colors hover:text-primary"
																onClick={() => openUrl(asset.url)}
															>
																{asset.name}
															</button>
															<Tooltip>
																<TooltipTrigger asChild>
																	<Button
																		type="button"
																		variant="ghost"
																		size="sm"
																		className="h-6 px-1.5 text-[10px]"
																		onClick={() =>
																			removeUploadedAsset(asset.id)
																		}
																	>
																		<LuX className="size-3" />
																	</Button>
																</TooltipTrigger>
																<TooltipContent side="top" showArrow={false}>
																	Remove attachment
																</TooltipContent>
															</Tooltip>
														</div>
													))}
												</div>
											</div>
										) : null}
										<div className="flex items-center justify-between gap-2">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="h-7 px-2 text-[11px]"
												onClick={() => openUrl(repositoryOverview.newIssueUrl)}
											>
												Open in GitHub
											</Button>
											<Button
												type="button"
												size="sm"
												className="h-7 px-2 text-[11px]"
												onClick={() => {
													void handleCreateIssue();
												}}
												disabled={
													createIssueMutation.isPending ||
													isUploadingAsset ||
													!issueTitle.trim()
												}
											>
												{createIssueMutation.isPending ? (
													<LuLoaderCircle className="mr-1 size-3 animate-spin" />
												) : null}
												Create Issue
											</Button>
										</div>
									</div>
								) : null}
							</div>

							<Collapsible
								open={pullRequestsOpen}
								onOpenChange={setPullRequestsOpen}
							>
								<CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
									<div className="flex items-center gap-1.5">
										<LuChevronDown
											className={cn(
												"size-3 shrink-0 text-muted-foreground transition-transform duration-150",
												!pullRequestsOpen && "-rotate-90",
											)}
										/>
										<p className="text-xs font-medium text-foreground">
											Open Pull Requests
										</p>
									</div>
									<span className="text-[11px] text-muted-foreground">
										{repositoryOverview.pullRequests.length}
									</span>
								</CollapsibleTrigger>
								<CollapsibleContent className="mt-1.5 space-y-1.5">
									{repositoryOverview.pullRequests.length === 0 ? (
										<p className="text-xs text-muted-foreground">
											No open pull requests.
										</p>
									) : (
										<div className="space-y-1">
											{repositoryOverview.pullRequests.map((pullRequest) => (
												<button
													key={pullRequest.number}
													type="button"
													className="flex w-full items-start justify-between gap-2 rounded-sm border border-border/50 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
													onClick={() => openUrl(pullRequest.url)}
												>
													<div className="min-w-0 flex-1">
														<p className="truncate text-xs font-medium text-foreground">
															#{pullRequest.number} {pullRequest.title}
														</p>
														<p className="truncate text-[11px] text-muted-foreground">
															{pullRequest.headRefName}
															{pullRequest.authorLogin
																? ` by ${pullRequest.authorLogin}`
																: ""}
														</p>
													</div>
													<div className="shrink-0 text-right">
														<p className="text-[10px] uppercase text-muted-foreground">
															{pullRequest.state}
														</p>
														<p className="text-[10px] text-muted-foreground">
															{formatRepositoryTimestamp(pullRequest.updatedAt)}
														</p>
													</div>
												</button>
											))}
										</div>
									)}
								</CollapsibleContent>
							</Collapsible>

							<Collapsible open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
								<CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
									<div className="flex items-center gap-1.5">
										<LuChevronDown
											className={cn(
												"size-3 shrink-0 text-muted-foreground transition-transform duration-150",
												!workflowsOpen && "-rotate-90",
											)}
										/>
										<p className="text-xs font-medium text-foreground">
											Workflows
										</p>
									</div>
									<span className="text-[11px] text-muted-foreground">
										{repositoryOverview.workflows.length}
									</span>
								</CollapsibleTrigger>
								<CollapsibleContent className="mt-1.5 space-y-1.5">
									{workspaceId && trackedWorkflowRuns.length > 0 ? (
										<div className="space-y-1">
											<p className="text-[11px] font-medium text-muted-foreground">
												Recent Runs
											</p>
											{trackedWorkflowRuns.map((tracked) => (
												<WorkflowRunCard
													key={`${tracked.workflowId}-${tracked.dispatchedAt}`}
													workspaceId={workspaceId}
													tracked={tracked}
													onOpenUrl={openUrl}
													onRemove={(workflowId) => {
														setTrackedWorkflowRuns((current) =>
															current.filter(
																(item) => item.workflowId !== workflowId,
															),
														);
													}}
													onViewLogs={(runId) => {
														void handleViewWorkflowLogs(runId);
													}}
												/>
											))}
										</div>
									) : null}
									<Input
										value={workflowRef}
										onChange={(event) => setWorkflowRef(event.target.value)}
										placeholder="Branch or ref to run"
									/>
									{repositoryOverview.workflows.length === 0 ? (
										<p className="text-xs text-muted-foreground">
											No workflows available.
										</p>
									) : (
										<div className="space-y-1">
											{repositoryOverview.workflows.map((workflow) => {
												const hasInputs =
													workflow.inputs && workflow.inputs.length > 0;
												const isExpanded = expandedWorkflowId === workflow.id;

												return (
													<div
														key={workflow.id}
														className="rounded-sm border border-border/50"
													>
														<div className="flex items-center justify-between gap-2 px-2 py-1.5">
															<div className="min-w-0 flex-1">
																<p className="truncate text-xs font-medium text-foreground">
																	{workflow.name}
																</p>
																<p className="truncate text-[11px] text-muted-foreground">
																	{workflow.path || workflow.state}
																</p>
															</div>
															<div className="flex items-center gap-1">
																{hasInputs ? (
																	<Button
																		type="button"
																		variant="outline"
																		size="sm"
																		className="h-7 shrink-0 px-2 text-[11px]"
																		onClick={() => {
																			if (isExpanded) {
																				setExpandedWorkflowId(null);
																			} else {
																				if (!workflowInputValues[workflow.id]) {
																					const defaults: Record<
																						string,
																						string
																					> = {};
																					for (const input of workflow.inputs) {
																						defaults[input.name] =
																							input.default ?? "";
																					}
																					setWorkflowInputValues((prev) => ({
																						...prev,
																						[workflow.id]: defaults,
																					}));
																				}
																				setExpandedWorkflowId(workflow.id);
																			}
																		}}
																	>
																		<LuChevronDown
																			className={cn(
																				"mr-1 size-3 transition-transform duration-150",
																				isExpanded && "rotate-180",
																			)}
																		/>
																		Conf
																	</Button>
																) : null}
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	className="h-7 shrink-0 px-2 text-[11px]"
																	onClick={() => {
																		void handleRunWorkflow(
																			workflow.id,
																			workflow.name,
																			hasInputs ? workflow.inputs : undefined,
																		);
																		if (hasInputs) {
																			setExpandedWorkflowId(null);
																		}
																	}}
																	disabled={
																		pendingWorkflowId === workflow.id ||
																		!workflowRef.trim()
																	}
																>
																	{pendingWorkflowId === workflow.id ? (
																		<LuLoaderCircle className="mr-1 size-3 animate-spin" />
																	) : (
																		<LuPlay className="mr-1 size-3" />
																	)}
																	Run
																</Button>
															</div>
														</div>
														{hasInputs && isExpanded ? (
															<div className="space-y-2 border-t border-border/50 px-2 py-2">
																{workflow.inputs.map((input) => {
																	const wfValues =
																		workflowInputValues[workflow.id] ?? {};
																	const value =
																		wfValues[input.name] ?? input.default ?? "";

																	const updateInput = (
																		key: string,
																		val: string,
																	) => {
																		setWorkflowInputValues((prev) => ({
																			...prev,
																			[workflow.id]: {
																				...prev[workflow.id],
																				[key]: val,
																			},
																		}));
																	};

																	if (input.type === "choice") {
																		return (
																			<div
																				key={input.name}
																				className="space-y-1"
																			>
																				<span className="text-[11px] text-muted-foreground">
																					{input.description || input.name}
																					{input.required ? (
																						<span className="ml-0.5 text-destructive">
																							*
																						</span>
																					) : null}
																				</span>
																				<Select
																					value={value}
																					onValueChange={(newValue) => {
																						updateInput(input.name, newValue);
																					}}
																				>
																					<SelectTrigger className="h-7 text-xs">
																						<SelectValue />
																					</SelectTrigger>
																					<SelectContent>
																						{input.options.map((option) => (
																							<SelectItem
																								key={option}
																								value={option}
																							>
																								{option}
																							</SelectItem>
																						))}
																					</SelectContent>
																				</Select>
																			</div>
																		);
																	}

																	if (input.type === "boolean") {
																		return (
																			<div
																				key={input.name}
																				className="flex items-center gap-2"
																			>
																				<Checkbox
																					id={`wf-input-${workflow.id}-${input.name}`}
																					checked={value === "true"}
																					onCheckedChange={(checked) => {
																						updateInput(
																							input.name,
																							String(checked),
																						);
																					}}
																				/>
																				<label
																					htmlFor={`wf-input-${workflow.id}-${input.name}`}
																					className="text-[11px] text-muted-foreground"
																				>
																					{input.description || input.name}
																				</label>
																			</div>
																		);
																	}

																	return (
																		<div key={input.name} className="space-y-1">
																			<span className="text-[11px] text-muted-foreground">
																				{input.description || input.name}
																				{input.required ? (
																					<span className="ml-0.5 text-destructive">
																						*
																					</span>
																				) : null}
																			</span>
																			<Input
																				type={
																					input.type === "number"
																						? "number"
																						: "text"
																				}
																				value={value}
																				onChange={(event) => {
																					updateInput(
																						input.name,
																						event.target.value,
																					);
																				}}
																				placeholder={
																					input.default || input.name
																				}
																				className="h-7 text-xs"
																			/>
																		</div>
																	);
																})}
															</div>
														) : null}
													</div>
												);
											})}
										</div>
									)}
								</CollapsibleContent>
							</Collapsible>
						</>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
