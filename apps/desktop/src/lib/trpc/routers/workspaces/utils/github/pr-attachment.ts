import type { GitHubStatus } from "@superset/local-db";
import { normalizeGitHubUrl } from "./repo-context";

type PullRequest = NonNullable<GitHubStatus["pr"]>;

export interface GitRemoteInfo {
	name: string;
	fetchUrl?: string;
	pushUrl?: string;
}

export interface GitTrackingRefInfo {
	remoteName: string;
	branchName: string;
}

export interface PullRequestPushTargetInfo {
	remote: string;
	targetBranch: string;
}

export function isOpenPullRequestState(state: PullRequest["state"]): boolean {
	return state === "open" || state === "draft";
}

export function getPullRequestHeadRepoUrl(
	pr: Pick<
		PullRequest,
		"headRepositoryOwner" | "headRepositoryName" | "isCrossRepository"
	>,
): string | null {
	if (
		!pr.isCrossRepository ||
		!pr.headRepositoryOwner ||
		!pr.headRepositoryName
	) {
		return null;
	}

	return `https://github.com/${pr.headRepositoryOwner}/${pr.headRepositoryName}`;
}

export function resolveRemoteNameForPullRequestHead({
	remotes,
	pr,
	fallbackRemote,
}: {
	remotes: GitRemoteInfo[];
	pr: Pick<
		PullRequest,
		"headRepositoryOwner" | "headRepositoryName" | "isCrossRepository"
	>;
	fallbackRemote: string;
}): string | null {
	if (!pr.isCrossRepository) {
		return fallbackRemote;
	}

	const headRepoUrl = getPullRequestHeadRepoUrl(pr);
	if (!headRepoUrl) {
		return null;
	}

	const normalizedHeadRepoUrl = normalizeGitHubUrl(headRepoUrl);
	if (!normalizedHeadRepoUrl) {
		return null;
	}

	for (const remote of remotes) {
		const fetchUrl = remote.fetchUrl
			? normalizeGitHubUrl(remote.fetchUrl)
			: null;
		const pushUrl = remote.pushUrl ? normalizeGitHubUrl(remote.pushUrl) : null;
		if (
			fetchUrl === normalizedHeadRepoUrl ||
			pushUrl === normalizedHeadRepoUrl
		) {
			return remote.name;
		}
	}

	return null;
}

export function resolveOpenPullRequestPushTarget({
	pr,
	remotes,
	fallbackRemote,
}: {
	pr: Pick<
		PullRequest,
		| "headRefName"
		| "headRepositoryOwner"
		| "headRepositoryName"
		| "isCrossRepository"
		| "state"
	>;
	remotes: GitRemoteInfo[];
	fallbackRemote: string;
}): PullRequestPushTargetInfo | null {
	if (!isOpenPullRequestState(pr.state)) {
		return null;
	}

	const targetBranch = pr.headRefName?.trim();
	if (!targetBranch) {
		return null;
	}

	const remote = resolveRemoteNameForPullRequestHead({
		remotes,
		pr,
		fallbackRemote,
	});
	if (!remote) {
		return null;
	}

	return {
		remote,
		targetBranch,
	};
}

export function canAttachPullRequestToWorkspace({
	pr,
	remotes,
	fallbackRemote,
}: {
	pr: Pick<
		PullRequest,
		| "headRefName"
		| "headRepositoryOwner"
		| "headRepositoryName"
		| "isCrossRepository"
		| "state"
	>;
	remotes: GitRemoteInfo[];
	fallbackRemote: string;
}): boolean {
	if (!isOpenPullRequestState(pr.state)) {
		return true;
	}

	return (
		resolveOpenPullRequestPushTarget({
			pr,
			remotes,
			fallbackRemote,
		}) !== null
	);
}
