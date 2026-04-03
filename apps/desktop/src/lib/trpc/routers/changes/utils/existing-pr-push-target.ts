import type { GitHubStatus } from "@superset/local-db";
import {
	type GitRemoteInfo,
	type GitTrackingRefInfo,
	getPullRequestHeadRepoUrl,
	isOpenPullRequestState,
	type PullRequestPushTargetInfo,
	resolveRemoteNameForPullRequestHead,
} from "../../workspaces/utils/github/pr-attachment";

export type { GitRemoteInfo };

type ExistingPullRequest = NonNullable<GitHubStatus["pr"]>;
export type ExistingPullRequestPushTargetInfo = PullRequestPushTargetInfo;
export { isOpenPullRequestState };

export function getExistingPRHeadRepoUrl(
	pr: Pick<
		ExistingPullRequest,
		"headRepositoryOwner" | "headRepositoryName" | "isCrossRepository"
	>,
): string | null {
	return getPullRequestHeadRepoUrl(pr);
}

export function resolveRemoteNameForExistingPRHead({
	remotes,
	pr,
	fallbackRemote,
}: {
	remotes: GitRemoteInfo[];
	pr: Pick<
		ExistingPullRequest,
		"headRepositoryOwner" | "headRepositoryName" | "isCrossRepository"
	>;
	fallbackRemote: string;
}): string | null {
	return resolveRemoteNameForPullRequestHead({
		remotes,
		pr,
		fallbackRemote,
	});
}

export function shouldRetargetPushToExistingPRHead({
	trackingRef,
	target,
}: {
	trackingRef: GitTrackingRefInfo | null;
	target: ExistingPullRequestPushTargetInfo;
}): boolean {
	if (!trackingRef) {
		return true;
	}

	return (
		trackingRef.remoteName !== target.remote ||
		trackingRef.branchName !== target.targetBranch
	);
}
