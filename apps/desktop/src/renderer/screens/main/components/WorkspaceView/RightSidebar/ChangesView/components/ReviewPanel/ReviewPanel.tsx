import type { GitHubStatus, PullRequestComment } from "@superset/local-db";
import { Avatar as UserAvatar } from "@superset/ui/atoms/Avatar";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	LuArrowUpRight,
	LuCheck,
	LuChevronDown,
	LuCode,
	LuCopy,
	LuExternalLink,
	LuLoaderCircle,
	LuRefreshCw,
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
	commentsQueryInput?: {
		workspaceId: string;
		prNumber?: number;
		prUrl?: string;
		repoUrl?: string;
		upstreamUrl?: string;
		isFork?: boolean;
	};
	onOpenFile?: (path: string, line?: number) => void;
	onRefreshReview?: (scope?: "full" | "status") => Promise<void>;
}

export function ReviewPanel({
	pr,
	comments = [],
	isLoading = false,
	isCommentsLoading = false,
	commentsQueryInput,
	onOpenFile,
	onRefreshReview,
}: ReviewPanelProps) {
	const resolvedWorkspaceId = useWorkspaceId();
	const trpcUtils = electronTrpc.useUtils();
	const addBrowserTab = useTabsStore((s) => s.addBrowserTab);
	const addActionLogsTab = useTabsStore((s) => s.addActionLogsTab);
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
	const rerunPullRequestChecksMutation =
		electronTrpc.workspaces.rerunPullRequestChecks.useMutation();
	const candidateKind =
		identityPopoverOpen === "assignees" ? "assignee" : "reviewer";
	const canEditPullRequest = pr?.state === "open" || pr?.state === "draft";
	const [pendingRerunMode, setPendingRerunMode] = useState<
		"all" | "failed" | null
	>(null);
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

		const nextIsDraft = pr.state !== "draft";
		const previousState = pr.state;

		setIsDraftTogglePending(true);
		trpcUtils.workspaces.getGitHubStatus.setData(
			{ workspaceId: resolvedWorkspaceId },
			(current) => {
				if (!current?.pr) {
					return current;
				}

				return {
					...current,
					pr: {
						...current.pr,
						state: nextIsDraft ? "draft" : "open",
					},
				};
			},
		);

		void setPullRequestDraftStateMutation
			.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				isDraft: nextIsDraft,
			})
			.then(() => refreshReview("status"))
			.catch((error) => {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				trpcUtils.workspaces.getGitHubStatus.setData(
					{ workspaceId: resolvedWorkspaceId },
					(current) => {
						if (!current?.pr) {
							return current;
						}

						return {
							...current,
							pr: {
								...current.pr,
								state: previousState,
							},
						};
					},
				);
				toast.error(`Failed to update pull request: ${message}`);
				void refreshReview("status");
			})
			.finally(() => {
				setIsDraftTogglePending(false);
			});
	};

	const handleToggleThreadResolution = (comment: PullRequestComment) => {
		if (!resolvedWorkspaceId || !comment.threadId) {
			return;
		}

		const nextResolved = comment.isResolved !== true;
		const updateThreadResolutionInCache = (isResolved: boolean) => {
			if (!commentsQueryInput) {
				return;
			}

			trpcUtils.workspaces.getGitHubPRComments.setData(
				commentsQueryInput,
				(current) =>
					(current ?? []).map((item) =>
						item.threadId === comment.threadId
							? {
									...item,
									isResolved,
								}
							: item,
					),
			);
		};

		setPendingThreadId(comment.threadId);
		updateThreadResolutionInCache(nextResolved);
		void setPullRequestThreadResolutionMutation
			.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				threadId: comment.threadId,
				isResolved: nextResolved,
			})
			.then(() => refreshReview("full"))
			.catch((error) => {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				updateThreadResolutionInCache(comment.isResolved === true);
				toast.error(`Failed to update conversation: ${message}`);
				void refreshReview("full");
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
							? (current.pr.requestedReviewers ?? [])
							: (current.pr.assignees ?? []);
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

	const restoreOptimisticMemberUpdate = useCallback(
		({ kind, values }: { kind: "reviewer" | "assignee"; values: string[] }) => {
			if (!resolvedWorkspaceId) {
				return;
			}

			trpcUtils.workspaces.getGitHubStatus.setData(
				{ workspaceId: resolvedWorkspaceId },
				(current) => {
					if (!current?.pr) {
						return current;
					}

					return {
						...current,
						pr: {
							...current.pr,
							...(kind === "reviewer"
								? { requestedReviewers: values }
								: { assignees: values }),
						},
					};
				},
			);
		},
		[resolvedWorkspaceId, trpcUtils],
	);

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
	const actionChecks = relevantChecks.filter((check) =>
		isActionsRunUrl(check.url),
	);
	const failedActionChecks = actionChecks.filter(
		(check) => check.status === "failure",
	);
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

	const handleRerunChecks = async (mode: "all" | "failed") => {
		if (!resolvedWorkspaceId || pendingRerunMode) {
			return;
		}

		setPendingRerunMode(mode);
		try {
			const result = await rerunPullRequestChecksMutation.mutateAsync({
				workspaceId: resolvedWorkspaceId,
				mode,
			});
			toast.success(
				mode === "failed"
					? `Re-ran failed jobs for ${result.rerunCount} workflow run${result.rerunCount === 1 ? "" : "s"}`
					: `Re-ran ${result.rerunCount} workflow run${result.rerunCount === 1 ? "" : "s"}`,
			);
			await refreshReview("status");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to rerun jobs: ${message}`);
		} finally {
			setPendingRerunMode((current) => (current === mode ? null : current));
		}
	};

	const updateReviewers = async ({
		add = [],
		remove = [],
		onSuccess,
	}: {
		add?: string[];
		remove?: string[];
		onSuccess?: () => void;
	}) => {
		if (!resolvedWorkspaceId || pendingIdentityGroup === "reviewers") {
			return;
		}

		const previousReviewers = [...requestedReviewers];
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
			onSuccess?.();
			void refreshReview("status");
		} catch (error) {
			restoreOptimisticMemberUpdate({
				kind: "reviewer",
				values: previousReviewers,
			});
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to update reviewers: ${message}`);
			void refreshReview("status");
		} finally {
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
		if (!resolvedWorkspaceId || pendingIdentityGroup === "assignees") {
			return;
		}

		const previousAssignees = [...assignees];
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
			onSuccess?.();
			void refreshReview("status");
		} catch (error) {
			restoreOptimisticMemberUpdate({
				kind: "assignee",
				values: previousAssignees,
			});
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to update assignees: ${message}`);
			void refreshReview("status");
		} finally {
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
		if (pendingIdentityGroup === pendingGroup) {
			return;
		}
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

	function isActionsJobUrl(url?: string) {
		return url ? /\/actions\/runs\/\d+\/job\/\d+/.test(url) : false;
	}

	function isActionsRunUrl(url?: string) {
		return url ? /\/actions\/runs\/\d+(?:\/|$)/.test(url) : false;
	}

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
		const identityCandidatesByLogin = new Map(
			identityCandidates.map(
				(candidate) => [candidate.login.toLowerCase(), candidate] as const,
			),
		);
		const query = searchValue.trim().toLowerCase();
		const filteredCandidates = !isOpen
			? []
			: identityCandidates
					.filter(
						(candidate) => !existingItems.has(candidate.login.toLowerCase()),
					)
					.filter((candidate) =>
						query ? candidate.login.toLowerCase().includes(query) : true,
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
							disabled={!canEditPullRequest || isPending}
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
								disabled={isPending}
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
								{items.length > 0
									? items.map((item) => (
											<CommandItem
												key={`${pendingGroup}-selected-${item}`}
												value={`selected-${item}`}
												disabled={isPending}
												onSelect={() => onRemove(item)}
												className="flex items-center justify-between gap-2 text-xs"
											>
												<div className="flex min-w-0 items-center gap-2">
													<UserAvatar
														size="xs"
														fullName={item}
														image={
															identityCandidatesByLogin.get(item.toLowerCase())
																?.avatarUrl
														}
													/>
													<LuCheck className="size-3.5 shrink-0 text-primary" />
													<span className="truncate">{item}</span>
												</div>
												<LuX className="size-3.5 shrink-0 text-muted-foreground" />
											</CommandItem>
										))
									: null}
								{filteredCandidates.map((candidate) => (
									<CommandItem
										key={`${pendingGroup}-${candidate.login}`}
										value={candidate.login}
										disabled={isPending}
										onSelect={() =>
											handleAddCandidate(pendingGroup, candidate.login)
										}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<div className="flex min-w-0 items-center gap-2">
											<UserAvatar
												size="xs"
												fullName={candidate.login}
												image={candidate.avatarUrl}
											/>
											<span className="truncate">{candidate.login}</span>
										</div>
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
							<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-xs font-medium text-foreground">
										{comment.authorLogin}
									</span>
									<span className="shrink-0 rounded border border-border/70 bg-muted/35 px-1 py-0 text-[9px] uppercase tracking-wide text-muted-foreground">
										{getCommentKindText(comment)}
									</span>
								</div>
								{age ? (
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{age}
									</span>
								) : null}
								{!isExpanded && (
									<p className="col-span-2 mt-0.5 truncate text-xs leading-4 text-muted-foreground">
										{getCommentPreviewText(comment.body)}
									</p>
								)}
							</div>
						</div>
					</button>

					{isExpanded && (
						<div className="px-1.5 pb-1.5">
							{hasFileLocation || comment.threadId ? (
								<div className="mb-1.5 ml-4 flex items-center gap-1.5">
									{hasFileLocation ? (
										<button
											type="button"
											className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300"
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

					<div
						className={cn(
							"absolute right-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
							"top-1",
						)}
					>
						{comment.url ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										aria-label="Open comment on GitHub"
										onClick={(e) => handleOpenUrl(comment.url as string, e)}
									>
										<LuArrowUpRight className="size-3" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="left" showArrow={false}>
									Open comment on GitHub
								</TooltipContent>
							</Tooltip>
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
							{pr.state === "draft" ? "Ready for review" : "Convert to draft"}
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
					{actionChecks.length > 0 ? (
						<div className="flex flex-wrap items-center justify-end gap-1 px-1.5 py-1">
							{resolvedWorkspaceId && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="h-6 px-2 text-[10px]"
									onClick={() => {
										const jobs = actionChecks
											.filter((c): c is typeof c & { url: string } => !!c.url)
											.map((c) => ({
												detailsUrl: c.url,
												name: c.name,
												status: c.status,
											}));
										const failedIdx = jobs.findIndex(
											(j) => j.status === "failure",
										);
										addActionLogsTab(
											resolvedWorkspaceId,
											jobs,
											failedIdx >= 0 ? failedIdx : undefined,
										);
									}}
								>
									<LuExternalLink className="mr-1 size-3" />
									View logs
								</Button>
							)}
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-6 px-2 text-[10px]"
								onClick={() => {
									void handleRerunChecks("failed");
								}}
								disabled={
									pendingRerunMode !== null || failedActionChecks.length === 0
								}
							>
								{pendingRerunMode === "failed" ? (
									<LuLoaderCircle className="mr-1 size-3 animate-spin" />
								) : (
									<LuRefreshCw className="mr-1 size-3" />
								)}
								Re-run failed jobs
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-6 px-2 text-[10px]"
								onClick={() => {
									void handleRerunChecks("all");
								}}
								disabled={pendingRerunMode !== null}
							>
								{pendingRerunMode === "all" ? (
									<LuLoaderCircle className="mr-1 size-3 animate-spin" />
								) : (
									<LuRefreshCw className="mr-1 size-3" />
								)}
								Re-run all jobs
							</Button>
						</div>
					) : null}
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
							const canExpand = isActionsJobUrl(check.url);

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
