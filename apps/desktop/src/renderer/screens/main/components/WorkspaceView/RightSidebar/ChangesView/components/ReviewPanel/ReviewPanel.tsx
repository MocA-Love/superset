import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import { Avatar, AvatarFallback, AvatarImage } from "@superset/ui/avatar";
import { Button } from "@superset/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@superset/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Skeleton } from "@superset/ui/skeleton";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	LuArrowUpRight,
	LuCheck,
	LuChevronDown,
	LuCode,
	LuCopy,
	LuLoaderCircle,
	LuX,
} from "react-icons/lu";
import { VscChevronRight } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { CodeBlock } from "renderer/components/MarkdownRenderer/components/CodeBlock";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { PRIcon } from "renderer/screens/main/components/PRIcon";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useTabsStore } from "renderer/stores/tabs";
import { CheckSteps } from "./components/CheckSteps";
import {
	ALL_COMMENTS_COPY_ACTION_KEY,
	buildAllCommentsClipboardText,
	buildCommentClipboardText,
	checkIconConfig,
	checkSummaryIconConfig,
	formatShortAge,
	getCommentAvatarFallback,
	getCommentCopyActionKey,
	getCommentKindText,
	getCommentPreviewText,
	resolveCheckDestinationUrl,
	reviewDecisionConfig,
	splitPullRequestComments,
	stripHtmlComments,
} from "./utils";

const CommentBody = memo(function CommentBody({
	body,
	onOpenUrl,
}: {
	body: string;
	onOpenUrl: (url: string, e: React.MouseEvent) => void;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkAlert]}
			rehypePlugins={[rehypeRaw, rehypeSanitize]}
			components={{
				a: ({ href, children }) =>
					href ? (
						<a
							href={href}
							className="text-primary underline"
							onClick={(e) => onOpenUrl(href, e)}
						>
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
				code: ({ className, children, node }) => (
					<CodeBlock className={className} node={node}>
						{children}
					</CodeBlock>
				),
			}}
		>
			{stripHtmlComments(body)}
		</ReactMarkdown>
	);
});

function buildIdentitySummary(items: string[]): string {
	if (items.length === 0) {
		return "None";
	}

	if (items.length <= 2) {
		return items.join(", ");
	}

	return `${items.slice(0, 2).join(", ")} +${items.length - 2}`;
}

interface ReviewPanelProps {
	pr: GitHubStatus["pr"] | null;
	comments?: PullRequestComment[];
	isLoading?: boolean;
	isCommentsLoading?: boolean;
	onOpenFile?: (path: string, line?: number) => void;
	onRefreshReview?: (scope?: "full" | "status") => Promise<void>;
}

export function ReviewPanel({
	pr,
	comments = [],
	isLoading = false,
	isCommentsLoading = false,
	onOpenFile,
	onRefreshReview,
}: ReviewPanelProps) {
	const resolvedWorkspaceId = useWorkspaceId();
	const trpcUtils = electronTrpc.useUtils();
	const addBrowserTab = useTabsStore((s) => s.addBrowserTab);
	const handleOpenUrl = useCallback(
		(url: string, e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (resolvedWorkspaceId) {
				addBrowserTab(resolvedWorkspaceId, url);
			}
		},
		[resolvedWorkspaceId, addBrowserTab],
	);

	const [checksOpen, setChecksOpen] = useState(true);
	const [commentsOpen, setCommentsOpen] = useState(true);
	const [resolvedCommentsGroupOpen, setResolvedCommentsGroupOpen] =
		useState(false);
	const [copiedActionKey, setCopiedActionKey] = useState<string | null>(null);
	const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
	const [expandedComments, setExpandedComments] = useState<Set<string>>(
		new Set(),
	);
	const [reviewerSearch, setReviewerSearch] = useState("");
	const [assigneeSearch, setAssigneeSearch] = useState("");
	const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
	const [isDraftTogglePending, setIsDraftTogglePending] = useState(false);
	const [identityPopoverOpen, setIdentityPopoverOpen] = useState<
		"reviewers" | "assignees" | null
	>(null);
	const [pendingIdentityGroup, setPendingIdentityGroup] = useState<
		"reviewers" | "assignees" | null
	>(null);
	const copiedActionResetTimeoutRef = useRef<ReturnType<
		typeof setTimeout
	> | null>(null);
	const copyToClipboardMutation = electronTrpc.external.copyText.useMutation();
	const setPullRequestDraftStateMutation =
		electronTrpc.workspaces.setPullRequestDraftState.useMutation();
	const setPullRequestThreadResolutionMutation =
		electronTrpc.workspaces.setPullRequestThreadResolution.useMutation();
	const updatePullRequestReviewersMutation =
		electronTrpc.workspaces.updatePullRequestReviewers.useMutation();
	const updatePullRequestAssigneesMutation =
		electronTrpc.workspaces.updatePullRequestAssignees.useMutation();
	const candidateKind =
		identityPopoverOpen === "assignees" ? "assignee" : "reviewer";
	const canEditPullRequest = pr?.state === "open" || pr?.state === "draft";
	const {
		data: identityCandidates = [],
		isLoading: isIdentityCandidatesLoading,
	} = electronTrpc.workspaces.getPullRequestIdentityCandidates.useQuery(
		{
			workspaceId: resolvedWorkspaceId ?? "",
			kind: candidateKind,
			pullRequestUrl: pr?.url,
		},
		{
			enabled:
				!!resolvedWorkspaceId && !!identityPopoverOpen && !!canEditPullRequest,
			staleTime: 60_000,
			refetchOnWindowFocus: false,
		},
	);

	useEffect(() => {
		return () => {
			if (copiedActionResetTimeoutRef.current) {
				clearTimeout(copiedActionResetTimeoutRef.current);
			}
		};
	}, []);

	const markCopiedAction = (actionKey: string) => {
		if (copiedActionResetTimeoutRef.current) {
			clearTimeout(copiedActionResetTimeoutRef.current);
		}

		setCopiedActionKey(actionKey);
		copiedActionResetTimeoutRef.current = setTimeout(() => {
			setCopiedActionKey(null);
			copiedActionResetTimeoutRef.current = null;
		}, 1500);
	};

	const copyTextToClipboard = async ({
		text,
		actionKey,
		errorLabel,
	}: {
		text: string;
		actionKey: string;
		errorLabel: string;
	}) => {
		try {
			await copyToClipboardMutation.mutateAsync(text);
			markCopiedAction(actionKey);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`${errorLabel}: ${message}`);
		}
	};

	const handleCopySingleComment = (comment: PullRequestComment) => {
		void copyTextToClipboard({
			text: buildCommentClipboardText(comment),
			actionKey: getCommentCopyActionKey(comment.id),
			errorLabel: "Failed to copy comment",
		});
	};

	const refreshReview = async (scope: "full" | "status" = "full") => {
		if (!onRefreshReview) {
			return;
		}

		await onRefreshReview(scope);
	};

	const handleToggleDraftState = () => {
		if (!resolvedWorkspaceId || !pr) {
			return;
		}

		setIsDraftTogglePending(true);
		void setPullRequestDraftStateMutation
			.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				isDraft: pr.state !== "draft",
			})
			.then(() => refreshReview("status"))
			.catch((error) => {
				const message = error instanceof Error ? error.message : "Unknown error";
				toast.error(`Failed to update pull request: ${message}`);
			})
			.finally(() => {
				setIsDraftTogglePending(false);
			});
	};

	const handleToggleThreadResolution = (comment: PullRequestComment) => {
		if (!resolvedWorkspaceId || !comment.threadId) {
			return;
		}

		setPendingThreadId(comment.threadId);
		void setPullRequestThreadResolutionMutation
			.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				threadId: comment.threadId,
				isResolved: comment.isResolved !== true,
			})
			.then(() => refreshReview("full"))
			.catch((error) => {
				const message = error instanceof Error ? error.message : "Unknown error";
				toast.error(`Failed to update conversation: ${message}`);
			})
			.finally(() => {
				setPendingThreadId((current) =>
					current === comment.threadId ? null : current,
				);
			});
	};

	const toggleCheckExpansion = (checkName: string) => {
		setExpandedChecks((prev) => {
			const next = new Set(prev);
			if (next.has(checkName)) {
				next.delete(checkName);
			} else {
				next.add(checkName);
			}
			return next;
		});
	};

	const toggleCommentExpansion = (commentId: string) => {
		setExpandedComments((prev) => {
			const next = new Set(prev);
			if (next.has(commentId)) {
				next.delete(commentId);
			} else {
				next.add(commentId);
			}
			return next;
		});
	};

	if (isLoading && !pr) {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Loading review...
			</div>
		);
	}

	if (!pr) {
		return (
			<div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
				Open a pull request to view review status, checks, and comments.
			</div>
		);
	}

	const requestedReviewers = pr.requestedReviewers ?? [];
	const assignees = pr.assignees ?? [];

	const relevantChecks = pr.checks.filter(
		(check) => check.status !== "skipped" && check.status !== "cancelled",
	);
	const passingChecks = relevantChecks.filter(
		(check) => check.status === "success",
	).length;
	const checksSummary =
		relevantChecks.length > 0
			? `${passingChecks}/${relevantChecks.length} checks passing`
			: "No checks reported";
	const checksStatus = relevantChecks.length > 0 ? pr.checksStatus : "none";
	const checksStatusConfig = checkSummaryIconConfig[checksStatus];
	const ChecksStatusIcon = checksStatusConfig.icon;
	const { active: activeComments, resolved: resolvedComments } =
		splitPullRequestComments(comments);
	const commentsCountLabel = isCommentsLoading ? "..." : comments.length;
	const copyAllCommentsLabel =
		copiedActionKey === ALL_COMMENTS_COPY_ACTION_KEY ? "Copied" : "Copy all";

	const handleCopyCommentsList = () => {
		void copyTextToClipboard({
			text: buildAllCommentsClipboardText(activeComments),
			actionKey: ALL_COMMENTS_COPY_ACTION_KEY,
			errorLabel: "Failed to copy comments",
		});
	};

	const applyOptimisticMemberUpdate = useCallback(
		({
			kind,
			add = [],
			remove = [],
		}: {
			kind: "reviewer" | "assignee";
			add?: string[];
			remove?: string[];
		}) => {
			if (!resolvedWorkspaceId) {
				return;
			}

			const normalizedAdd = Array.from(
				new Set(add.map((value) => value.trim()).filter(Boolean)),
			);
			const normalizedRemove = new Set(
				remove.map((value) => value.trim()).filter(Boolean),
			);

			trpcUtils.workspaces.getGitHubStatus.setData(
				{ workspaceId: resolvedWorkspaceId },
				(current) => {
					if (!current?.pr) {
						return current;
					}

					const existingValues =
						kind === "reviewer"
							? current.pr.requestedReviewers ?? []
							: current.pr.assignees ?? [];
					const nextValues = Array.from(
						new Set(
							existingValues
								.filter((value) => !normalizedRemove.has(value))
								.concat(normalizedAdd),
						),
					);

					return {
						...current,
						pr: {
							...current.pr,
							...(kind === "reviewer"
								? { requestedReviewers: nextValues }
								: { assignees: nextValues }),
						},
					};
				},
			);
		},
		[resolvedWorkspaceId, trpcUtils],
	);

	const updateReviewers = async ({
		add = [],
		remove = [],
		onSuccess,
	}: {
		add?: string[];
		remove?: string[];
		onSuccess?: () => void;
	}) => {
		if (!resolvedWorkspaceId) {
			return;
		}

		const startedAt = Date.now();
		console.log("[ReviewPanel] updateReviewers:start", {
			workspaceId: resolvedWorkspaceId,
			add,
			remove,
			pullRequestNumber: pr?.number,
		});
		setPendingIdentityGroup("reviewers");
		try {
			applyOptimisticMemberUpdate({
				kind: "reviewer",
				add,
				remove,
			});
			await updatePullRequestReviewersMutation.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				add,
				remove,
				pullRequestNumber: pr?.number,
				pullRequestUrl: pr?.url,
			});
			console.log("[ReviewPanel] updateReviewers:mutationDone", {
				workspaceId: resolvedWorkspaceId,
				durationMs: Date.now() - startedAt,
			});
			onSuccess?.();
			void refreshReview("status");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to update reviewers: ${message}`);
			void refreshReview("status");
		} finally {
			console.log("[ReviewPanel] updateReviewers:done", {
				workspaceId: resolvedWorkspaceId,
				totalDurationMs: Date.now() - startedAt,
			});
			setPendingIdentityGroup((current) =>
				current === "reviewers" ? null : current,
			);
		}
	};

	const updateAssignees = async ({
		add = [],
		remove = [],
		onSuccess,
	}: {
		add?: string[];
		remove?: string[];
		onSuccess?: () => void;
	}) => {
		if (!resolvedWorkspaceId) {
			return;
		}

		const startedAt = Date.now();
		console.log("[ReviewPanel] updateAssignees:start", {
			workspaceId: resolvedWorkspaceId,
			add,
			remove,
			pullRequestNumber: pr?.number,
		});
		setPendingIdentityGroup("assignees");
		try {
			applyOptimisticMemberUpdate({
				kind: "assignee",
				add,
				remove,
			});
			await updatePullRequestAssigneesMutation.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				add,
				remove,
				pullRequestNumber: pr?.number,
				pullRequestUrl: pr?.url,
			});
			console.log("[ReviewPanel] updateAssignees:mutationDone", {
				workspaceId: resolvedWorkspaceId,
				durationMs: Date.now() - startedAt,
			});
			onSuccess?.();
			void refreshReview("status");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to update assignees: ${message}`);
			void refreshReview("status");
		} finally {
			console.log("[ReviewPanel] updateAssignees:done", {
				workspaceId: resolvedWorkspaceId,
				totalDurationMs: Date.now() - startedAt,
			});
			setPendingIdentityGroup((current) =>
				current === "assignees" ? null : current,
			);
		}
	};

	const handleRemoveReviewer = (reviewer: string) => {
		setIdentityPopoverOpen(null);
		setReviewerSearch("");
		void updateReviewers({ remove: [reviewer] });
	};

	const handleRemoveAssignee = (assignee: string) => {
		setIdentityPopoverOpen(null);
		setAssigneeSearch("");
		void updateAssignees({ remove: [assignee] });
	};

	const handleAddCandidate = (
		pendingGroup: "reviewers" | "assignees",
		candidate: string,
	) => {
		setIdentityPopoverOpen(null);
		if (pendingGroup === "assignees") {
			setAssigneeSearch("");
		} else {
			setReviewerSearch("");
		}

		if (pendingGroup === "reviewers") {
			void updateReviewers({ add: [candidate] });
			return;
		}

		void updateAssignees({ add: [candidate] });
	};

	const isActionsUrl = (url?: string) =>
		url ? /\/actions\/runs\/\d+\/job\/\d+/.test(url) : false;

	const renderIdentitySection = ({
		label,
		items,
		onRemove,
		pendingGroup,
	}: {
		label: string;
		items: string[];
		onRemove: (value: string) => void;
		pendingGroup: "reviewers" | "assignees";
	}) => {
		const isPending = pendingIdentityGroup === pendingGroup;
		const isOpen = identityPopoverOpen === pendingGroup;
		const summary = buildIdentitySummary(items);
		const searchValue =
			pendingGroup === "assignees" ? assigneeSearch : reviewerSearch;
		const existingItems = new Set(items.map((item) => item.toLowerCase()));
		const query = searchValue.trim().toLowerCase();
		const filteredCandidates = !isOpen
			? []
			: identityCandidates
					.filter((candidate) => !existingItems.has(candidate.toLowerCase()))
					.filter((candidate) =>
						query ? candidate.toLowerCase().includes(query) : true,
					)
					.slice(0, 8);

		return (
			<div className="rounded-sm border border-border/60 bg-muted/15 px-2 py-1.5">
				<Popover
					open={isOpen}
					onOpenChange={(nextOpen) => {
						setIdentityPopoverOpen(nextOpen ? pendingGroup : null);
						if (!nextOpen) {
							if (pendingGroup === "assignees") {
								setAssigneeSearch("");
							} else {
								setReviewerSearch("");
							}
						}
					}}
				>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="flex w-full items-center justify-between gap-2 rounded-sm text-left transition-colors hover:bg-accent/40"
							disabled={!canEditPullRequest}
						>
							<div className="flex min-w-0 items-center gap-2 px-0.5">
								<span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
									{label}
								</span>
								<span
									className="truncate text-[11px] text-foreground/85"
									title={items.join(", ")}
								>
									{summary}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-1 text-muted-foreground">
								{isPending ? (
									<LuLoaderCircle className="size-3 animate-spin" />
								) : null}
								<LuChevronDown
									className={cn(
										"size-3 transition-transform",
										isOpen && "rotate-180",
									)}
								/>
							</div>
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="w-[var(--radix-popover-trigger-width)] min-w-[220px] p-0"
						onWheel={(event) => event.stopPropagation()}
					>
						<Command shouldFilter={false}>
							<CommandInput
								placeholder={`Search ${label.toLowerCase()}...`}
								value={searchValue}
								onValueChange={
									pendingGroup === "assignees"
										? setAssigneeSearch
										: setReviewerSearch
								}
							/>
							<CommandList className="max-h-[240px]">
								<CommandEmpty>
									{isIdentityCandidatesLoading
										? "Loading..."
										: "No candidates found"}
								</CommandEmpty>
								{items.length > 0 ? (
									<>
										{items.map((item) => (
											<CommandItem
												key={`${pendingGroup}-selected-${item}`}
												value={`selected-${item}`}
												onSelect={() => onRemove(item)}
												className="flex items-center justify-between gap-2 text-xs"
											>
												<div className="flex min-w-0 items-center gap-2">
													<LuCheck className="size-3.5 shrink-0 text-primary" />
													<span className="truncate">{item}</span>
												</div>
												<LuX className="size-3.5 shrink-0 text-muted-foreground" />
											</CommandItem>
										))}
									</>
								) : null}
								{filteredCandidates.map((candidate) => (
									<CommandItem
										key={`${pendingGroup}-${candidate}`}
										value={candidate}
										onSelect={() => handleAddCandidate(pendingGroup, candidate)}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<span className="truncate">{candidate}</span>
										<LuCheck className="size-3.5 shrink-0 opacity-0" />
									</CommandItem>
								))}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			</div>
		);
	};

	const renderCommentList = (list: PullRequestComment[]) =>
		list.map((comment) => {
			const age = formatShortAge(comment.createdAt);
			const commentCopyActionKey = getCommentCopyActionKey(comment.id);
			const isCopied = copiedActionKey === commentCopyActionKey;
			const isExpanded = expandedComments.has(comment.id);
			const hasFileLocation = !!comment.path;

			return (
				<div
					key={comment.id}
					className="group relative rounded-sm transition-colors hover:bg-accent/50"
				>
					<button
						type="button"
						className="flex w-full items-start gap-1 px-1.5 py-1 cursor-pointer text-left"
						onClick={() => toggleCommentExpansion(comment.id)}
					>
						<LuChevronDown
							className={cn(
								"mt-1 size-3 shrink-0 text-muted-foreground transition-transform duration-150",
								!isExpanded && "-rotate-90",
							)}
						/>
						<Avatar className="mt-0.5 size-4 shrink-0">
							{comment.avatarUrl ? (
								<AvatarImage
									src={comment.avatarUrl}
									alt={comment.authorLogin}
								/>
							) : null}
							<AvatarFallback className="text-[10px] font-medium">
								{getCommentAvatarFallback(comment.authorLogin)}
							</AvatarFallback>
						</Avatar>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-xs font-medium text-foreground">
									{comment.authorLogin}
								</span>
								<span className="shrink-0 rounded border border-border/70 bg-muted/35 px-1 py-0 text-[9px] uppercase tracking-wide text-muted-foreground">
									{getCommentKindText(comment)}
								</span>
								<span className="flex-1" />
								{age ? (
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{age}
									</span>
								) : null}
							</div>
							{!isExpanded && (
								<p className="mt-0.5 line-clamp-1 text-xs leading-4 text-muted-foreground">
									{getCommentPreviewText(comment.body)}
								</p>
							)}
						</div>
					</button>

					{isExpanded && (
						<div className="px-1.5 pb-1.5">
							{hasFileLocation || comment.threadId ? (
								<div className="mb-1.5 ml-4 flex flex-wrap items-center gap-1.5">
									{hasFileLocation ? (
										<button
											type="button"
											className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300"
											onClick={(e) => {
												e.stopPropagation();
												if (comment.path) {
													onOpenFile?.(comment.path, comment.line);
												}
											}}
										>
											<LuCode className="size-3" />
											<span className="truncate">
												{comment.path}
												{comment.line ? `:${comment.line}` : ""}
											</span>
										</button>
									) : null}
									{comment.threadId ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="h-5 px-1.5 text-[10px]"
											onClick={(e) => {
												e.stopPropagation();
												handleToggleThreadResolution(comment);
											}}
											disabled={pendingThreadId === comment.threadId}
										>
											{pendingThreadId === comment.threadId ? (
												<LuLoaderCircle className="mr-1 size-3 animate-spin" />
											) : null}
											{comment.isResolved
												? "Unresolve conversation"
												: "Resolve conversation"}
										</Button>
									) : null}
								</div>
							) : null}
							<div className="review-comment-body ml-4 break-words text-xs leading-5 text-foreground/90">
								<CommentBody body={comment.body} onOpenUrl={handleOpenUrl} />
							</div>
						</div>
					)}

					<div className="absolute right-1 top-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
						{comment.url ? (
							<button
								type="button"
								className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								aria-label="Open comment on GitHub"
								onClick={(e) => handleOpenUrl(comment.url as string, e)}
							>
								<LuArrowUpRight className="size-3" />
							</button>
						) : null}
						<button
							type="button"
							className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								handleCopySingleComment(comment);
							}}
							aria-label={isCopied ? "Copied comment" : "Copy comment"}
						>
							{isCopied ? (
								<LuCheck className="size-3" />
							) : (
								<LuCopy className="size-3" />
							)}
						</button>
					</div>
				</div>
			);
		});

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<div className="px-2 py-2 space-y-1.5">
				<button
					type="button"
					className="group flex w-full items-center gap-1.5 cursor-pointer text-left"
					onClick={(e) => pr.url && handleOpenUrl(pr.url, e)}
				>
					<PRIcon state={pr.state} className="size-4 shrink-0" />
					<span
						className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
						title={pr.title}
					>
						{pr.title}
					</span>
					<LuArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100" />
				</button>
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-1.5">
						<span
							className={cn(
								"shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
								reviewDecisionConfig[pr.reviewDecision].className,
							)}
						>
							{reviewDecisionConfig[pr.reviewDecision].label}
						</span>
						{requestedReviewers.length > 0 && (
							<span className="truncate text-[10px] text-muted-foreground">
								Awaiting {requestedReviewers.join(", ")}
							</span>
						)}
					</div>
					{pr.state === "open" || pr.state === "draft" ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-6 shrink-0 px-2 text-[10px]"
							onClick={handleToggleDraftState}
							disabled={isDraftTogglePending}
						>
							{isDraftTogglePending ? (
								<LuLoaderCircle className="mr-1 size-3 animate-spin" />
							) : null}
							{pr.state === "draft"
								? "Ready for review"
								: "Convert to draft"}
						</Button>
					) : null}
				</div>
				<div className="grid grid-cols-2 gap-1.5">
					{renderIdentitySection({
						label: "Assignees",
						items: assignees,
						onRemove: handleRemoveAssignee,
						pendingGroup: "assignees",
					})}
					{renderIdentitySection({
						label: "Reviewers",
						items: requestedReviewers,
						onRemove: handleRemoveReviewer,
						pendingGroup: "reviewers",
					})}
				</div>
			</div>

			<div className="border-b border-border/70 my-1" />

			<Collapsible open={checksOpen} onOpenChange={setChecksOpen}>
				<CollapsibleTrigger
					className={cn(
						"flex w-full min-w-0 items-center justify-between gap-2 px-2 py-1.5 text-left",
						"hover:bg-accent/30 cursor-pointer transition-colors",
					)}
				>
					<div className="flex min-w-0 items-center gap-1.5">
						<VscChevronRight
							className={cn(
								"size-3 text-muted-foreground shrink-0 transition-transform duration-150",
								checksOpen && "rotate-90",
							)}
						/>
						<span className="text-xs font-medium truncate">Checks</span>
						<span className="text-[10px] text-muted-foreground shrink-0">
							{relevantChecks.length}
						</span>
					</div>
					<div
						className={cn(
							"shrink-0 flex items-center gap-1",
							checksStatusConfig.className,
						)}
					>
						<ChecksStatusIcon
							className={cn(
								"size-3.5 shrink-0",
								checksStatus === "pending" && "animate-spin",
							)}
						/>
						<span className="max-w-[140px] truncate text-[10px] normal-case">
							{checksSummary}
						</span>
					</div>
				</CollapsibleTrigger>
				<CollapsibleContent className="px-0.5 pb-1 min-w-0 overflow-hidden">
					{relevantChecks.length === 0 ? (
						<div className="px-1.5 py-1 text-xs text-muted-foreground">
							No checks reported.
						</div>
					) : (
						relevantChecks.map((check) => {
							const { icon: CheckIcon, className } =
								checkIconConfig[check.status];
							const checkUrl = resolveCheckDestinationUrl(check, pr.url);
							const isCheckExpanded = expandedChecks.has(check.name);
							const canExpand = isActionsUrl(check.url);

							return (
								<div key={check.name}>
									<div className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-colors hover:bg-accent/50">
										{canExpand ? (
											<button
												type="button"
												className="flex min-w-0 flex-1 items-center gap-1"
												onClick={() => toggleCheckExpansion(check.name)}
											>
												<LuChevronDown
													className={cn(
														"size-3 shrink-0 text-muted-foreground transition-transform duration-150",
														!isCheckExpanded && "-rotate-90",
													)}
												/>
												<CheckIcon
													className={cn(
														"size-3 shrink-0",
														className,
														check.status === "pending" && "animate-spin",
													)}
												/>
												<span className="min-w-0 truncate text-left">
													{check.name}
												</span>
											</button>
										) : (
											<div className="flex min-w-0 flex-1 items-center gap-1">
												<CheckIcon
													className={cn(
														"size-3 shrink-0",
														className,
														check.status === "pending" && "animate-spin",
													)}
												/>
												<span className="min-w-0 truncate">{check.name}</span>
											</div>
										)}
										{checkUrl ? (
											<a
												href={checkUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
												onClick={(e) => e.stopPropagation()}
											>
												<LuArrowUpRight className="size-3.5" />
											</a>
										) : null}
										{check.durationText && (
											<span className="shrink-0 text-[10px] text-muted-foreground">
												{check.durationText}
											</span>
										)}
									</div>
									{isCheckExpanded && check.url && (
										<CheckSteps detailsUrl={check.url} />
									)}
								</div>
							);
						})
					)}
				</CollapsibleContent>
			</Collapsible>

			<div className="border-b border-border/70 my-1" />

			<Collapsible
				open={commentsOpen}
				onOpenChange={setCommentsOpen}
				className="min-w-0"
			>
				<div className="flex min-w-0 items-center">
					<CollapsibleTrigger
						className={cn(
							"flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1.5 text-left",
							"hover:bg-accent/30 cursor-pointer transition-colors",
						)}
					>
						<VscChevronRight
							className={cn(
								"size-3 text-muted-foreground shrink-0 transition-transform duration-150",
								commentsOpen && "rotate-90",
							)}
						/>
						<span className="text-xs font-medium truncate">Comments</span>
						<span className="text-[10px] text-muted-foreground shrink-0">
							{commentsCountLabel}
						</span>
					</CollapsibleTrigger>
					{activeComments.length > 0 && (
						<button
							type="button"
							className="mr-1.5 shrink-0 flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
							onClick={handleCopyCommentsList}
						>
							{copiedActionKey === ALL_COMMENTS_COPY_ACTION_KEY ? (
								<LuCheck className="size-3" />
							) : (
								<LuCopy className="size-3" />
							)}
							<span>{copyAllCommentsLabel}</span>
						</button>
					)}
				</div>
				<CollapsibleContent className="px-0.5 pb-1 min-w-0 overflow-hidden">
					{isCommentsLoading ? (
						<div className="space-y-1 px-1">
							<Skeleton className="h-11 w-full rounded-sm" />
							<Skeleton className="h-11 w-full rounded-sm" />
							<Skeleton className="h-11 w-full rounded-sm" />
						</div>
					) : comments.length === 0 ? (
						<div className="px-1.5 py-1 text-xs text-muted-foreground">
							No comments yet.
						</div>
					) : (
						renderCommentList(activeComments)
					)}
				</CollapsibleContent>
			</Collapsible>

			{resolvedComments.length > 0 && (
				<Collapsible
					open={resolvedCommentsGroupOpen}
					onOpenChange={setResolvedCommentsGroupOpen}
					className="min-w-0"
				>
					<CollapsibleTrigger
						className={cn(
							"flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left",
							"hover:bg-accent/30 cursor-pointer transition-colors",
						)}
					>
						<VscChevronRight
							className={cn(
								"size-3 text-muted-foreground shrink-0 transition-transform duration-150",
								resolvedCommentsGroupOpen && "rotate-90",
							)}
						/>
						<span className="text-xs font-medium truncate">Resolved</span>
						<span className="text-[10px] text-muted-foreground shrink-0">
							{resolvedComments.length}
						</span>
					</CollapsibleTrigger>
					<CollapsibleContent className="px-0.5 pb-1 min-w-0 overflow-hidden">
						{renderCommentList(resolvedComments)}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}
