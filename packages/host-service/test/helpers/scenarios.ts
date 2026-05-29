import { join } from "node:path";
import {
	createTestHost,
	type TestHost,
	type TestHostOptions,
} from "./createTestHost";
import { createGitFixture, type GitFixture } from "./git-fixture";
import { seedProject, seedWorkspace } from "./seed";

export interface BasicScenario {
	host: TestHost;
	repo: GitFixture;
	projectId: string;
	workspaceId: string;
	dispose(): Promise<void>;
}

export interface BasicScenarioOptions {
	hostOptions?: TestHostOptions;
}

export async function createBasicScenario(
	options: BasicScenarioOptions = {},
): Promise<BasicScenario> {
	const host = await createTestHost(options.hostOptions);
	const repo = await createGitFixture();

	const { id: projectId } = seedProject(host, { repoPath: repo.repoPath });
	const { id: workspaceId } = seedWorkspace(host, {
		projectId,
		worktreePath: repo.repoPath,
		branch: "main",
	});

	return {
		host,
		repo,
		projectId,
		workspaceId,
		dispose: async () => {
			await host.dispose();
			repo.dispose();
		},
	};
}

export interface FeatureWorktreeScenario extends BasicScenario {
	worktreePath: string;
	branch: string;
	featureWorkspaceId: string;
}

export interface FeatureWorktreeScenarioOptions extends BasicScenarioOptions {
	branch?: string;
}

export async function createFeatureWorktreeScenario(
	options: FeatureWorktreeScenarioOptions = {},
): Promise<FeatureWorktreeScenario> {
	const basic = await createBasicScenario(options);
	const branch = options.branch ?? "feature/cleanup";
	const worktreePath = join(
		basic.repo.repoPath,
		".worktrees",
		branch.replace(/\//g, "-"),
	);
	await basic.repo.git.raw(["worktree", "add", "-b", branch, worktreePath]);

	const { id: featureWorkspaceId } = seedWorkspace(basic.host, {
		projectId: basic.projectId,
		worktreePath,
		branch,
	});

	return {
		...basic,
		worktreePath,
		branch,
		featureWorkspaceId,
	};
}

export async function createProjectScenario(
	options: BasicScenarioOptions = {},
): Promise<{
	host: TestHost;
	repo: GitFixture;
	projectId: string;
	dispose(): Promise<void>;
}> {
	const host = await createTestHost(options.hostOptions);
	const repo = await createGitFixture();
	const { id: projectId } = seedProject(host, { repoPath: repo.repoPath });
	return {
		host,
		repo,
		projectId,
		dispose: async () => {
			await host.dispose();
			repo.dispose();
		},
	};
}
