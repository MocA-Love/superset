import { TRPCError } from "@trpc/server";
import type { SimpleGit } from "simple-git";
import { z } from "zod";
import { getBranchPullRequestBaseRepoConfig } from "../../workspaces/utils/base-branch-config";
import { fetchGitHubPRStatus } from "../../workspaces/utils/github";
import {
	extractNwoFromUrl,
	getRepoContext,
	getTrackingRepoUrl,
} from "../../workspaces/utils/github/repo-context";
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

export interface PullRequestBaseRepoOption {
	label: string;
	repoNameWithOwner: string;
	repoUrl: string;
	source: "current" | "tracking" | "upstream";
}

function getPullRequestBaseRepoLabel(
	repoNameWithOwner: string,
	source: PullRequestBaseRepoOption["source"],
): string {
	switch (source) {
		case "tracking":
			return `${repoNameWithOwner} (tracking remote)`;
		case "upstream":
			return `${repoNameWithOwner} (upstream repository)`;
		default:
			return `${repoNameWithOwner} (current repository)`;
	}
}

export async function getPullRequestBaseRepoOptions(
	worktreePath: string,
): Promise<PullRequestBaseRepoOption[]> {
	const [repoContext, trackingRepoUrl] = await Promise.all([
		getRepoContext(worktreePath),
		getTrackingRepoUrl(worktreePath),
	]);

	if (!repoContext) {
		return [];
	}

	const candidates: Array<{
		repoUrl: string | null;
		source: PullRequestBaseRepoOption["source"];
	}> = [
		{ repoUrl: trackingRepoUrl, source: "tracking" },
		{ repoUrl: repoContext.repoUrl, source: "current" },
		{
			repoUrl: repoContext.isFork ? repoContext.upstreamUrl : null,
			source: "upstream",
		},
	];

	const options = new Map<string, PullRequestBaseRepoOption>();
	for (const candidate of candidates) {
		const normalizedRepoUrl = normalizeGitHubRepoUrl(candidate.repoUrl ?? "");
		if (!normalizedRepoUrl || options.has(normalizedRepoUrl)) {
			continue;
		}

		const repoNameWithOwner = extractNwoFromUrl(normalizedRepoUrl);
		if (!repoNameWithOwner) {
			continue;
		}

		options.set(normalizedRepoUrl, {
			label: getPullRequestBaseRepoLabel(repoNameWithOwner, candidate.source),
			repoNameWithOwner,
			repoUrl: normalizedRepoUrl,
			source: candidate.source,
		});
	}

	return [...options.values()];
}

export async function resolvePullRequestBaseRepoSelection({
	worktreePath,
	branch,
	preferredBaseRepoUrl,
}: {
	worktreePath: string;
	branch: string;
	preferredBaseRepoUrl?: string | null;
}): Promise<{
	baseRepoOptions: PullRequestBaseRepoOption[];
	selectedBaseRepoUrl: string | null;
}> {
	const [baseRepoOptions, configuredBaseRepo] = await Promise.all([
		getPullRequestBaseRepoOptions(worktreePath),
		getBranchPullRequestBaseRepoConfig({
			repoPath: worktreePath,
			branch,
		}),
	]);

	const normalizedPreferredBaseRepoUrl = preferredBaseRepoUrl
		? normalizeGitHubRepoUrl(preferredBaseRepoUrl)
		: null;
	if (
		normalizedPreferredBaseRepoUrl &&
		baseRepoOptions.some(
			(option) => option.repoUrl === normalizedPreferredBaseRepoUrl,
		)
	) {
		return {
			baseRepoOptions,
			selectedBaseRepoUrl: normalizedPreferredBaseRepoUrl,
		};
	}

	const normalizedConfiguredBaseRepoUrl = configuredBaseRepo.baseRepoUrl
		? normalizeGitHubRepoUrl(configuredBaseRepo.baseRepoUrl)
		: null;
	if (
		normalizedConfiguredBaseRepoUrl &&
		baseRepoOptions.some(
			(option) => option.repoUrl === normalizedConfiguredBaseRepoUrl,
		)
	) {
		return {
			baseRepoOptions,
			selectedBaseRepoUrl: normalizedConfiguredBaseRepoUrl,
		};
	}

	if (baseRepoOptions.length === 1) {
		return {
			baseRepoOptions,
			selectedBaseRepoUrl: baseRepoOptions[0]?.repoUrl ?? null,
		};
	}

	return {
		baseRepoOptions,
		selectedBaseRepoUrl: null,
	};
}

export async function buildNewPullRequestUrl(
	worktreePath: string,
	git: SimpleGit,
	branch: string,
	preferredBaseRepoUrl?: string | null,
): Promise<string> {
	const { stdout } = await execWithShellEnv(
		"gh",
		["repo", "view", "--json", "url,isFork,parent,defaultBranchRef"],
		{ cwd: worktreePath },
	);
	const repoMetadata = ghRepoMetadataSchema.parse(JSON.parse(stdout));
	const currentRepoUrl = normalizeGitHubRepoUrl(repoMetadata.url);
	const { selectedBaseRepoUrl } = await resolvePullRequestBaseRepoSelection({
		worktreePath,
		branch,
		preferredBaseRepoUrl,
	});
	const baseRepoUrl = selectedBaseRepoUrl;

	if (!currentRepoUrl) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "GitHub is not available for this workspace.",
		});
	}

	if (!baseRepoUrl) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Multiple base repositories are available. Choose a base repository before creating a pull request.",
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
