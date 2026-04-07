import { getSimpleGitWithShellPath } from "./git-client";

interface BranchConfigParams {
	repoPath: string;
	branch: string;
}

interface SetBranchBaseConfigParams extends BranchConfigParams {
	compareBaseBranch: string;
	isExplicit: boolean;
}

interface BranchBaseConfig {
	compareBaseBranch: string | null;
	isExplicit: boolean;
}

export interface BranchPullRequestBaseRepoConfig {
	baseRepoUrl: string | null;
}

function parseBooleanConfig(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on" ||
		normalized === "1"
	);
}

export async function getBranchBaseConfig({
	repoPath,
	branch,
}: BranchConfigParams): Promise<BranchBaseConfig> {
	const git = await getSimpleGitWithShellPath(repoPath);
	const [baseOutput, explicitOutput] = await Promise.all([
		git.raw(["config", `branch.${branch}.base`]).catch(() => ""),
		git
			.raw(["config", "--bool", `branch.${branch}.base-explicit`])
			.catch(() => ""),
	]);

	return {
		compareBaseBranch: baseOutput.trim() || null,
		isExplicit: parseBooleanConfig(explicitOutput),
	};
}

export async function setBranchBaseConfig({
	repoPath,
	branch,
	compareBaseBranch,
	isExplicit,
}: SetBranchBaseConfigParams): Promise<void> {
	const git = await getSimpleGitWithShellPath(repoPath);

	await git
		.raw(["config", `branch.${branch}.base`, compareBaseBranch])
		.catch(() => {});
	if (isExplicit) {
		await git
			.raw(["config", "--bool", `branch.${branch}.base-explicit`, "true"])
			.catch(() => {});
		return;
	}

	await git
		.raw(["config", "--unset", `branch.${branch}.base-explicit`])
		.catch(() => {});
}

export async function unsetBranchBaseConfig({
	repoPath,
	branch,
}: BranchConfigParams): Promise<void> {
	const git = await getSimpleGitWithShellPath(repoPath);
	await Promise.all([
		git.raw(["config", "--unset", `branch.${branch}.base`]).catch(() => {}),
		git
			.raw(["config", "--unset", `branch.${branch}.base-explicit`])
			.catch(() => {}),
	]);
}

export async function getBranchPullRequestBaseRepoConfig({
	repoPath,
	branch,
}: BranchConfigParams): Promise<BranchPullRequestBaseRepoConfig> {
	const git = await getSimpleGitWithShellPath(repoPath);
	const baseRepoOutput = await git
		.raw(["config", `branch.${branch}.pr-base-repo`])
		.catch(() => "");

	return {
		baseRepoUrl: baseRepoOutput.trim() || null,
	};
}

export async function setBranchPullRequestBaseRepoConfig({
	repoPath,
	branch,
	baseRepoUrl,
}: BranchConfigParams & { baseRepoUrl: string }): Promise<void> {
	const git = await getSimpleGitWithShellPath(repoPath);
	await git
		.raw(["config", `branch.${branch}.pr-base-repo`, baseRepoUrl])
		.catch(() => {});
}

export async function unsetBranchPullRequestBaseRepoConfig({
	repoPath,
	branch,
}: BranchConfigParams): Promise<void> {
	const git = await getSimpleGitWithShellPath(repoPath);
	await git
		.raw(["config", "--unset", `branch.${branch}.pr-base-repo`])
		.catch(() => {});
}
