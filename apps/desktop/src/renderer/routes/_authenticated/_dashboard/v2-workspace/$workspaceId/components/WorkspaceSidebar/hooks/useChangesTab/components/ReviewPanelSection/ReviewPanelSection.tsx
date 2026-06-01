import type { GitHubStatus } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback, useState } from "react";
import { VscRefresh } from "react-icons/vsc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	getGitHubPRCommentsQueryPolicy,
	getGitHubStatusQueryPolicy,
} from "renderer/lib/githubQueryPolicy";
import { ReviewPanel } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/ReviewPanel";
import {
	checkSummaryIconConfig,
	countOpenPullRequestComments,
} from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/ReviewPanel/utils";
import type { ActionLogsJob } from "shared/tabs-types";
import type { CommentPaneData } from "../../../../../../types";

type GitHubStatusCacheValue = GitHubStatus | null | undefined;

interface ReviewPanelSectionProps {
	workspaceId: string;
	isActive: boolean;
	onOpenFileAtLine?: (path: string, line?: number) => void;
	onOpenComment?: (comment: CommentPaneData) => void;
	onOpenUrl?: (url: string) => void;
}

function buildGitHubCommentsQueryInput({
	workspaceId,
	githubStatus,
	forceFresh,
}: {
	workspaceId: string;
	githubStatus:
		| {
				pr?: {
					number: number;
					url: string;
				} | null;
				repoUrl?: string;
				upstreamUrl?: string;
				isFork?: boolean;
		  }
		| null
		| undefined;
	forceFresh?: boolean;
}) {
	if (!githubStatus?.pr) {
		return {
			workspaceId,
			...(forceFresh ? { forceFresh: true } : {}),
		};
	}

	return {
		workspaceId,
		prNumber: githubStatus.pr.number,
		prUrl: githubStatus.pr.url,
		repoUrl: githubStatus.repoUrl,
		upstreamUrl: githubStatus.upstreamUrl,
		isFork: githubStatus.isFork,
		...(forceFresh ? { forceFresh: true } : {}),
	};
}

export function ReviewPanelSection({
	workspaceId,
	isActive,
	onOpenFileAtLine,
	onOpenComment,
	onOpenUrl,
}: ReviewPanelSectionProps) {
	const trpcUtils = electronTrpc.useUtils();
	const [isReviewRefreshing, setIsReviewRefreshing] = useState(false);
	const githubStatusQueryPolicy = getGitHubStatusQueryPolicy(
		"changes-sidebar",
		{
			hasWorkspaceId: !!workspaceId,
			isActive,
			isReviewTabActive: isActive,
		},
	);
	const { data: githubStatus, isLoading: isGitHubStatusLoading } =
		electronTrpc.workspaces.getGitHubStatus.useQuery(
			{ workspaceId },
			githubStatusQueryPolicy,
		);
	const activePullRequest = githubStatus?.pr ?? null;
	const githubPRCommentsQueryPolicy = getGitHubPRCommentsQueryPolicy({
		hasWorkspaceId: !!workspaceId,
		hasActivePullRequest: !!activePullRequest,
		isActive,
		isReviewTabActive: isActive,
	});
	const { data: githubComments = [], isLoading: isGitHubCommentsLoading } =
		electronTrpc.workspaces.getGitHubPRComments.useQuery(
			buildGitHubCommentsQueryInput({
				workspaceId,
				githubStatus,
			}),
			githubPRCommentsQueryPolicy,
		);

	const setGitHubStatusCaches = useCallback(
		(
			nextValue:
				| GitHubStatusCacheValue
				| ((current: GitHubStatusCacheValue) => GitHubStatusCacheValue),
		) => {
			trpcUtils.workspaces.getGitHubStatus.setData({ workspaceId }, nextValue);
			trpcUtils.workspaces.getGitHubStatus.setData(
				{ workspaceId, includePreview: true },
				nextValue,
			);
		},
		[trpcUtils, workspaceId],
	);

	const handleReviewRefresh = useCallback(
		async (scope: "full" | "status" = "full") => {
			if (!workspaceId || isReviewRefreshing) {
				return;
			}

			setIsReviewRefreshing(true);
			try {
				const freshGitHubStatus =
					await trpcUtils.workspaces.getGitHubStatus.fetch({
						workspaceId,
						forceFresh: true,
						includePreview: true,
					});
				setGitHubStatusCaches(freshGitHubStatus);

				if (scope === "full") {
					const freshComments =
						await trpcUtils.workspaces.getGitHubPRComments.fetch(
							buildGitHubCommentsQueryInput({
								workspaceId,
								githubStatus: freshGitHubStatus,
								forceFresh: true,
							}),
						);
					trpcUtils.workspaces.getGitHubPRComments.setData(
						buildGitHubCommentsQueryInput({
							workspaceId,
							githubStatus: freshGitHubStatus,
						}),
						freshComments,
					);
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				toast.error(`Failed to refresh review: ${message}`);
			} finally {
				setIsReviewRefreshing(false);
			}
		},
		[isReviewRefreshing, setGitHubStatusCaches, trpcUtils, workspaceId],
	);

	const reviewCommentCount = activePullRequest
		? countOpenPullRequestComments(githubComments)
		: 0;
	const relevantReviewTabChecks =
		activePullRequest?.checks.filter(
			(check) => check.status !== "skipped" && check.status !== "cancelled",
		) ?? [];
	const reviewTabChecksStatus =
		relevantReviewTabChecks.length > 0
			? (activePullRequest?.checksStatus ?? "none")
			: "none";
	const reviewTabChecksStatusConfig =
		checkSummaryIconConfig[reviewTabChecksStatus];
	const ReviewTabChecksIcon = reviewTabChecksStatusConfig.icon;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<div className="flex h-8 shrink-0 items-center gap-2 border-b bg-background px-3 text-xs font-medium text-foreground">
				<span>Review</span>
				<span className="text-[11px] text-muted-foreground/60 tabular-nums">
					{reviewCommentCount}
				</span>
				{activePullRequest ? (
					<ReviewTabChecksIcon
						className={[
							"size-3 shrink-0",
							reviewTabChecksStatusConfig.className,
							reviewTabChecksStatus === "pending" ? "animate-spin" : "",
						]
							.filter(Boolean)
							.join(" ")}
					/>
				) : null}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => {
								void handleReviewRefresh();
							}}
							disabled={isReviewRefreshing || !workspaceId}
							className="ml-auto size-6 p-0"
						>
							<VscRefresh
								className={`size-3.5 ${isReviewRefreshing ? "animate-spin" : ""}`}
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top" showArrow={false}>
						Refresh review
					</TooltipContent>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1">
				<ReviewPanel
					pr={isGitHubStatusLoading ? null : activePullRequest}
					comments={githubComments}
					isLoading={isGitHubStatusLoading}
					isCommentsLoading={isGitHubCommentsLoading}
					commentsQueryInput={buildGitHubCommentsQueryInput({
						workspaceId,
						githubStatus,
					})}
					onOpenFile={onOpenFileAtLine}
					onOpenComment={(comment) =>
						onOpenComment?.({
							commentId: comment.id,
							authorLogin: comment.authorLogin,
							avatarUrl: comment.avatarUrl,
							body: comment.body,
							url: comment.url,
							path: comment.path,
							line: comment.line,
						})
					}
					onOpenUrl={onOpenUrl}
					onOpenActionLogs={(jobs, initialJobIndex) => {
						openActionLogInBrowser(jobs, initialJobIndex, onOpenUrl);
					}}
					onRefreshReview={handleReviewRefresh}
				/>
			</div>
		</div>
	);
}

function openActionLogInBrowser(
	jobs: ActionLogsJob[],
	initialJobIndex: number | undefined,
	onOpenUrl: ((url: string) => void) | undefined,
) {
	if (!onOpenUrl) return;
	const job =
		(initialJobIndex !== undefined ? jobs[initialJobIndex] : undefined) ??
		jobs.find((candidate) => candidate.status === "failure") ??
		jobs[0];
	if (job) onOpenUrl(job.detailsUrl);
}
