import { router } from "../..";

/**
 * Fork-local tRPC router that hosts the 19 GitHub Repository Tools procedures
 * that upstream #3295 removed from `procedures/git-status.ts`. Keeping them in
 * a dedicated namespace lets us adopt upstream's lightweight git-status/github
 * helpers while preserving the fork's extended GitHub features.
 *
 * Target procedures (moved progressively during PR #5):
 *   cleanupMissingWorktrees, createGitHubIssue, dispatchGitHubWorkflow,
 *   getCheckJobSteps, getGitHubRepositoryOverview, getGitHubWorkflowRuns,
 *   getJobLogs, getJobStatuses, getMissingWorktrees,
 *   getPullRequestIdentityCandidates, getWorkflowRunJobs,
 *   replyToPullRequestComment, rerunPullRequestChecks, setActiveSyncWorkspace,
 *   setPullRequestDraftState, setPullRequestThreadResolution,
 *   updatePullRequestAssignees, updatePullRequestReviewers,
 *   uploadGitHubIssueAsset
 */
export const createGithubExtendedRouter = () => router({});

export type GithubExtendedRouter = ReturnType<typeof createGithubExtendedRouter>;
