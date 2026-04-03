import { TRPCError } from "@trpc/server";
import type { SimpleGit } from "simple-git";
import { z } from "zod";
import { fetchGitHubPRStatus } from "../../workspaces/utils/github";
import { execWithShellEnv } from "../../workspaces/utils/shell-env";
import {
	buildPullRequestCompareUrl,
	normalizeGitHubRepoUrl,
	parseUpstreamRef,
} from "./pull-request-url";
import { clearWorktreeStatusCaches } from "./worktree-status-caches";

export async function findExistingOpenPRUrl(
	worktreePath: string,
): Promise<string | null> {
	clearWorktreeStatusCaches(worktreePath);
	const githubStatus = await fetchGitHubPRStatus(worktreePath);
	const pullRequest = githubStatus?.pr;
	if (pullRequest?.state !== "open" && pullRequest?.state !== "draft") {
		return null;
	}

	return pullRequest.url.trim() || null;
}

const ghRepoMetadataSchema = z.object({
	url: z.string().url(),
	isFork: z.boolean(),
	parent: z
		.object({
			url: z.string().url(),
		})
		.nullable(),
	defaultBranchRef: z.object({
		name: z.string().min(1),
	}),
});

async function getMergeBaseBranch(
	git: SimpleGit,
	branch: string,
): Promise<string | null> {
	try {
		const configuredBaseBranch = await git.raw([
			"config",
			"--get",
			`branch.${branch}.gh-merge-base`,
		]);
		return configuredBaseBranch.trim() || null;
	} catch {
		return null;
	}
}

export async function buildNewPullRequestUrl(
	worktreePath: string,
	git: SimpleGit,
	branch: string,
): Promise<string> {
	const { stdout } = await execWithShellEnv(
		"gh",
		["repo", "view", "--json", "url,isFork,parent,defaultBranchRef"],
		{ cwd: worktreePath },
	);
	const repoMetadata = ghRepoMetadataSchema.parse(JSON.parse(stdout));
	const currentRepoUrl = normalizeGitHubRepoUrl(repoMetadata.url);
	const baseRepoUrl = normalizeGitHubRepoUrl(
		repoMetadata.isFork && repoMetadata.parent?.url
			? repoMetadata.parent.url
			: repoMetadata.url,
	);

	if (!currentRepoUrl || !baseRepoUrl) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "GitHub is not available for this workspace.",
		});
	}

	const configuredBaseBranch = await getMergeBaseBranch(git, branch);
	const baseBranch = configuredBaseBranch ?? repoMetadata.defaultBranchRef.name;
	let headRepoOwner = currentRepoUrl.split("/").at(-2) ?? "";
	let headBranch = branch;

	try {
		const upstreamRef = (
			await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"])
		).trim();
		const parsedUpstreamRef = parseUpstreamRef(upstreamRef);

		if (parsedUpstreamRef) {
			headBranch = parsedUpstreamRef.branchName;
			const upstreamRemoteUrl = await git.raw([
				"remote",
				"get-url",
				parsedUpstreamRef.remoteName,
			]);
			headRepoOwner =
				normalizeGitHubRepoUrl(upstreamRemoteUrl)?.split("/").at(-2) ??
				headRepoOwner;
		}
	} catch {
		// Fall back to the current repository owner and local branch name.
	}

	return buildPullRequestCompareUrl({
		baseRepoUrl,
		baseBranch,
		headRepoOwner,
		headBranch,
	});
}
