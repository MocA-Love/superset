import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
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
import { Skeleton } from "@superset/ui/skeleton";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
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

export function RepositoryPanel({ isActive = true }: RepositoryPanelProps) {
	const workspaceId = useWorkspaceId();
	const trpcUtils = electronTrpc.useUtils();
	const addBrowserTab = useTabsStore((state) => state.addBrowserTab);
	const [open, setOpen] = useState(false);
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
	const {
		data: repositoryOverview,
		isLoading,
		error,
	} = electronTrpc.workspaces.getGitHubRepositoryOverview.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: !!workspaceId && isActive,
			staleTime: 60_000,
			refetchOnWindowFocus: isActive,
		},
	);
	const createIssueMutation =
		electronTrpc.workspaces.createGitHubIssue.useMutation();
	const uploadIssueAssetMutation =
		electronTrpc.workspaces.uploadGitHubIssueAsset.useMutation();
	const dispatchWorkflowMutation =
		electronTrpc.workspaces.dispatchGitHubWorkflow.useMutation();

	const availableAssignees = repositoryOverview?.issueAssignees ?? [];
	const availableLabels = repositoryOverview?.issueLabels ?? [];
	const filteredAssignees = useMemo(() => {
		const query = issueAssigneeSearch.trim().toLowerCase();
		return availableAssignees.filter((candidate) => {
			if (issueAssignees.includes(candidate)) {
				return false;
			}

			return query ? candidate.toLowerCase().includes(query) : true;
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

		await trpcUtils.workspaces.getGitHubRepositoryOverview.invalidate({
			workspaceId,
		});
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
			const uploaded = [];
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
	) => {
		if (!workspaceId) {
			return;
		}

		setPendingWorkflowId(workflowId);
		try {
			const result = await dispatchWorkflowMutation.mutateAsync({
				workspaceId,
				workflowId,
				ref: workflowRef.trim() || undefined,
			});
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
																			key={assignee}
																			onSelect={() =>
																				setIssueAssignees((current) => [
																					...current,
																					assignee,
																				])
																			}
																		>
																			<span className="truncate">
																				{assignee}
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
														<LuUserPlus className="size-3" />
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
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-6 px-1.5 text-[10px]"
																onClick={() => removeUploadedAsset(asset.id)}
															>
																<LuX className="size-3" />
															</Button>
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

							<div className="space-y-1.5">
								<div className="flex items-center justify-between gap-2">
									<p className="text-xs font-medium text-foreground">
										Open Pull Requests
									</p>
									<span className="text-[11px] text-muted-foreground">
										{repositoryOverview.pullRequests.length}
									</span>
								</div>
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
							</div>

							<div className="space-y-1.5">
								<div className="flex items-center justify-between gap-2">
									<p className="text-xs font-medium text-foreground">
										Workflows
									</p>
									<span className="text-[11px] text-muted-foreground">
										{repositoryOverview.workflows.length}
									</span>
								</div>
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
										{repositoryOverview.workflows.map((workflow) => (
											<div
												key={workflow.id}
												className="flex items-center justify-between gap-2 rounded-sm border border-border/50 px-2 py-1.5"
											>
												<div className="min-w-0 flex-1">
													<p className="truncate text-xs font-medium text-foreground">
														{workflow.name}
													</p>
													<p className="truncate text-[11px] text-muted-foreground">
														{workflow.path || workflow.state}
													</p>
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="h-7 shrink-0 px-2 text-[11px]"
													onClick={() => {
														void handleRunWorkflow(workflow.id, workflow.name);
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
										))}
									</div>
								)}
							</div>
						</>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
