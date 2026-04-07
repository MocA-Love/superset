import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { and, eq, inArray } from "drizzle-orm";
import type { HostDb } from "../../db";
import { projects, pullRequests, workspaces } from "../../db/schema";
import type { GitFactory } from "../git";
import { fetchRepositoryPullRequests } from "./utils/github-query";
import { parseGitHubRemote } from "./utils/parse-github-remote";
import {
	type ChecksStatus,
	coerceChecksStatus,
	coercePullRequestState,
	coerceReviewDecision,
	computeChecksStatus,
	mapPullRequestState,
	mapReviewDecision,
	type PullRequestCheck,
	type PullRequestState,
	parseCheckContexts,
	parseChecksJson,
	type ReviewDecision,
} from "./utils/pull-request-mappers";

const BRANCH_SYNC_INTERVAL_MS = 30_000;
const PROJECT_REFRESH_INTERVAL_MS = 30_000;
const UNBORN_HEAD_ERROR_PATTERNS = [
	"ambiguous argument 'head'",
	"unknown revision or path not in the working tree",
	"bad revision 'head'",
	"not a valid object name head",
	"needed a single revision",
];

async function getCurrentBranchName(git: Awaited<ReturnType<GitFactory>>) {
	try {
		const branch = await git.raw(["symbolic-ref", "--short", "HEAD"]);
		const trimmed = branch.trim();
		return trimmed || null;
	} catch {
		try {
			const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
			const trimmed = branch.trim();
			return trimmed && trimmed !== "HEAD" ? trimmed : null;
		} catch {
			return null;
		}
	}
}

async function getHeadSha(git: Awaited<ReturnType<GitFactory>>) {
	try {
		const branch = await git.revparse(["HEAD"]);
		const trimmed = branch.trim();
		return trimmed || null;
	} catch (error) {
		const message =
			error instanceof Error
				? error.message.toLowerCase()
				: String(error).toLowerCase();
		if (
			UNBORN_HEAD_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
		) {
			return null;
		}

		throw error;
	}
}

type RepoProvider = "github";

export interface PullRequestStateSnapshot {
	url: string;
	number: number;
	title: string;
	state: PullRequestState;
	reviewDecision: ReviewDecision;
	checksStatus: ChecksStatus;
	checks: PullRequestCheck[];
}

export interface PullRequestWorkspaceSnapshot {
	workspaceId: string;
	pullRequest: PullRequestStateSnapshot | null;
	error: string | null;
	lastFetchedAt: string | null;
}

export interface PullRequestRuntimeManagerOptions {
	db: HostDb;
	git: GitFactory;
	github: () => Promise<Octokit>;
}

interface NormalizedRepoIdentity {
	provider: RepoProvider;
	owner: string;
	name: string;
	url: string;
	remoteName: string;
}

interface PullRequestMatchCandidate {
	id: string;
	node: Awaited<ReturnType<typeof fetchRepositoryPullRequests>>[number];
}

function getRepoKey(
	repo: Pick<NormalizedRepoIdentity, "provider" | "owner" | "name">,
) {
	return `${repo.provider}:${repo.owner}/${repo.name}`;
}

function getPullRequestStatePriority(state: "OPEN" | "CLOSED" | "MERGED") {
	switch (state) {
		case "OPEN":
			return 3;
		case "MERGED":
			return 2;
		default:
			return 1;
	}
}

function comparePullRequestCandidates(
	a: PullRequestMatchCandidate,
	b: PullRequestMatchCandidate,
	headSha: string | null,
) {
	const aHeadShaMatches = Boolean(headSha && a.node.headRefOid === headSha);
	const bHeadShaMatches = Boolean(headSha && b.node.headRefOid === headSha);
	if (aHeadShaMatches !== bHeadShaMatches) {
		return aHeadShaMatches ? -1 : 1;
	}

	const stateDelta =
		getPullRequestStatePriority(b.node.state) -
		getPullRequestStatePriority(a.node.state);
	if (stateDelta !== 0) {
		return stateDelta;
	}

	return (
		new Date(b.node.updatedAt).getTime() - new Date(a.node.updatedAt).getTime()
	);
}

function getTrackingRemoteName(upstreamRef: string | null) {
	if (!upstreamRef) return null;

	const trimmed = upstreamRef.trim();
	if (!trimmed) return null;

	const slashIndex = trimmed.indexOf("/");
	return slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed;
}

function branchMatchesPullRequestHead(
	branch: string,
	headRefName: string,
	headRepositoryOwner: string | null,
) {
	if (branch === headRefName) {
		return true;
	}

	if (!headRepositoryOwner) {
		return false;
	}

	return branch === `${headRepositoryOwner}/${headRefName}`;
}

export class PullRequestRuntimeManager {
	private readonly db: HostDb;
	private readonly git: GitFactory;
	private readonly github: () => Promise<Octokit>;
	private branchSyncTimer: ReturnType<typeof setInterval> | null = null;
	private projectRefreshTimer: ReturnType<typeof setInterval> | null = null;
	private readonly inFlightProjects = new Map<string, Promise<void>>();
	private readonly nextProjectRefreshAt = new Map<string, number>();

	constructor(options: PullRequestRuntimeManagerOptions) {
		this.db = options.db;
		this.git = options.git;
		this.github = options.github;
	}

	start() {
		if (this.branchSyncTimer || this.projectRefreshTimer) return;

		this.branchSyncTimer = setInterval(() => {
			void this.syncWorkspaceBranches();
		}, BRANCH_SYNC_INTERVAL_MS);
		this.projectRefreshTimer = setInterval(() => {
			void this.refreshEligibleProjects();
		}, PROJECT_REFRESH_INTERVAL_MS);

		void this.syncWorkspaceBranches();
		void this.refreshEligibleProjects(true);
	}

	stop() {
		if (this.branchSyncTimer) clearInterval(this.branchSyncTimer);
		if (this.projectRefreshTimer) clearInterval(this.projectRefreshTimer);
		this.branchSyncTimer = null;
		this.projectRefreshTimer = null;
	}

	async getPullRequestsByWorkspaces(
		workspaceIds: string[],
	): Promise<PullRequestWorkspaceSnapshot[]> {
		if (workspaceIds.length === 0) return [];

		const rows = this.db
			.select({
				workspaceId: workspaces.id,
				pullRequestUrl: pullRequests.url,
				pullRequestNumber: pullRequests.prNumber,
				pullRequestTitle: pullRequests.title,
				pullRequestState: pullRequests.state,
				pullRequestReviewDecision: pullRequests.reviewDecision,
				pullRequestChecksStatus: pullRequests.checksStatus,
				pullRequestChecksJson: pullRequests.checksJson,
				pullRequestLastFetchedAt: pullRequests.lastFetchedAt,
				pullRequestError: pullRequests.error,
			})
			.from(workspaces)
			.leftJoin(pullRequests, eq(workspaces.pullRequestId, pullRequests.id))
			.where(inArray(workspaces.id, workspaceIds))
			.all();

		return rows.map((row) => ({
			workspaceId: row.workspaceId,
			pullRequest:
				row.pullRequestUrl &&
				row.pullRequestNumber !== null &&
				row.pullRequestNumber !== undefined
					? {
							url: row.pullRequestUrl,
							number: row.pullRequestNumber,
							title: row.pullRequestTitle ?? "",
							state: coercePullRequestState(row.pullRequestState),
							reviewDecision: coerceReviewDecision(
								row.pullRequestReviewDecision,
							),
							checksStatus: coerceChecksStatus(row.pullRequestChecksStatus),
							checks: parseChecksJson(row.pullRequestChecksJson),
						}
					: null,
			error: row.pullRequestError ?? null,
			lastFetchedAt: row.pullRequestLastFetchedAt
				? new Date(row.pullRequestLastFetchedAt).toISOString()
				: null,
		}));
	}

	async refreshPullRequestsByWorkspaces(workspaceIds: string[]): Promise<void> {
		if (workspaceIds.length === 0) return;

		const rows = this.db
			.select({
				projectId: workspaces.projectId,
			})
			.from(workspaces)
			.where(inArray(workspaces.id, workspaceIds))
			.all();

		const projectIds = [...new Set(rows.map((row) => row.projectId))];
		await Promise.all(
			projectIds.map((projectId) => this.refreshProject(projectId, true)),
		);
	}

	private async syncWorkspaceBranches(): Promise<void> {
		const allWorkspaces = this.db.select().from(workspaces).all();
		const changedProjectIds = new Set<string>();

		for (const workspace of allWorkspaces) {
			try {
				const git = await this.git(workspace.worktreePath);
				const branch = await getCurrentBranchName(git);
				if (!branch) {
					continue;
				}
				const headSha = await getHeadSha(git);

				if (branch === workspace.branch && headSha === workspace.headSha) {
					continue;
				}

				this.db
					.update(workspaces)
					.set({
						branch,
						headSha,
					})
					.where(eq(workspaces.id, workspace.id))
					.run();

				changedProjectIds.add(workspace.projectId);
			} catch (error) {
				console.warn(
					"[host-service:pull-request-runtime] Failed to sync workspace branch",
					{
						workspaceId: workspace.id,
						worktreePath: workspace.worktreePath,
						error,
					},
				);
			}
		}

		await Promise.all(
			[...changedProjectIds].map((projectId) =>
				this.refreshProject(projectId, true),
			),
		);
	}

	private async refreshEligibleProjects(force = false): Promise<void> {
		const rows = this.db
			.select({
				projectId: workspaces.projectId,
			})
			.from(workspaces)
			.all();
		const projectIds = [...new Set(rows.map((row) => row.projectId))];
		await Promise.all(
			projectIds.map((projectId) => this.refreshProject(projectId, force)),
		);
	}

	private async refreshProject(
		projectId: string,
		force = false,
	): Promise<void> {
		const now = Date.now();
		const existing = this.inFlightProjects.get(projectId);
		if (existing) {
			await existing;
			return;
		}

		const nextEligibleRefreshAt = this.nextProjectRefreshAt.get(projectId) ?? 0;
		if (!force && nextEligibleRefreshAt > now) {
			return;
		}

		const refreshPromise = this.performProjectRefresh(projectId)
			.catch((error) => {
				console.warn(
					"[host-service:pull-request-runtime] Project refresh failed",
					{
						projectId,
						error,
					},
				);
			})
			.finally(() => {
				this.inFlightProjects.delete(projectId);
				this.nextProjectRefreshAt.set(
					projectId,
					Date.now() + PROJECT_REFRESH_INTERVAL_MS,
				);
			});

		this.inFlightProjects.set(projectId, refreshPromise);
		await refreshPromise;
	}

	private async performProjectRefresh(projectId: string): Promise<void> {
		const projectWorkspaces = this.db
			.select()
			.from(workspaces)
			.where(eq(workspaces.projectId, projectId))
			.all();
		if (projectWorkspaces.length === 0) return;

		const projectRepo = await this.getProjectRepository(projectId);
		const branchNames = [
			...new Set(projectWorkspaces.map((workspace) => workspace.branch)),
		];

		const workspaceRepos = await Promise.all(
			projectWorkspaces.map(async (workspace) => {
				try {
					return {
						workspace,
						repos: await this.getWorkspaceRepositories(
							workspace.worktreePath,
							projectRepo,
						),
					};
				} catch (error) {
					console.warn(
						"[host-service:pull-request-runtime] Failed to resolve workspace repositories",
						{
							workspaceId: workspace.id,
							worktreePath: workspace.worktreePath,
							error,
						},
					);

					return {
						workspace,
						repos: projectRepo ? [projectRepo] : [],
					};
				}
			}),
		);

		const repos = [
			...new Map(
				workspaceRepos
					.flatMap(({ repos }) => repos)
					.map((repo) => [getRepoKey(repo), repo]),
			).values(),
		];
		if (repos.length === 0) return;

		const repoToPullRequests = new Map<string, PullRequestMatchCandidate[]>();
		for (const repo of repos) {
			repoToPullRequests.set(
				getRepoKey(repo),
				await this.fetchRepoPullRequests(projectId, repo, branchNames),
			);
		}

		for (const { workspace, repos: candidateRepos } of workspaceRepos) {
			const match = this.findBestPullRequestMatch(
				workspace.branch,
				workspace.headSha,
				candidateRepos,
				repoToPullRequests,
			);
			this.db
				.update(workspaces)
				.set({
					pullRequestId: match?.id ?? null,
				})
				.where(eq(workspaces.id, workspace.id))
				.run();
		}
	}

	private async getWorkspaceRepositories(
		worktreePath: string,
		projectRepo: NormalizedRepoIdentity | null,
	): Promise<NormalizedRepoIdentity[]> {
		const git = await this.git(worktreePath);
		const repos: NormalizedRepoIdentity[] = [];
		const pushRepo = (repo: NormalizedRepoIdentity | null) => {
			if (!repo) return;
			if (repos.some((existing) => getRepoKey(existing) === getRepoKey(repo))) {
				return;
			}
			repos.push(repo);
		};

		let trackingRemoteName: string | null = null;
		try {
			trackingRemoteName = getTrackingRemoteName(
				await git.raw([
					"rev-parse",
					"--abbrev-ref",
					"--symbolic-full-name",
					"@{upstream}",
				]),
			);
		} catch {}

		pushRepo(
			trackingRemoteName
				? await this.getRemoteRepository(git, trackingRemoteName)
				: null,
		);
		pushRepo(await this.getRemoteRepository(git, "origin"));
		pushRepo(await this.getRemoteRepository(git, "upstream"));
		pushRepo(projectRepo);

		return repos;
	}

	private async getRemoteRepository(
		git: Awaited<ReturnType<GitFactory>>,
		remoteName: string,
	): Promise<NormalizedRepoIdentity | null> {
		try {
			const remoteUrl = await git.remote(["get-url", remoteName]);
			if (typeof remoteUrl !== "string") {
				return null;
			}

			const parsedRemote = parseGitHubRemote(remoteUrl);
			if (!parsedRemote) return null;

			return {
				...parsedRemote,
				remoteName,
			};
		} catch {
			return null;
		}
	}

	private async getProjectRepository(
		projectId: string,
	): Promise<NormalizedRepoIdentity | null> {
		const project = this.db.query.projects
			.findFirst({ where: eq(projects.id, projectId) })
			.sync();
		if (!project) return null;

		if (
			project.repoProvider === "github" &&
			project.repoOwner &&
			project.repoName &&
			project.repoUrl &&
			project.remoteName
		) {
			return {
				provider: "github",
				owner: project.repoOwner,
				name: project.repoName,
				url: project.repoUrl,
				remoteName: project.remoteName,
			};
		}

		const git = await this.git(project.repoPath);
		const remoteName = "origin";
		let remoteUrl: string;
		try {
			const value = await git.remote(["get-url", remoteName]);
			if (typeof value !== "string") {
				return null;
			}
			remoteUrl = value.trim();
		} catch {
			return null;
		}

		const parsedRemote = parseGitHubRemote(remoteUrl);
		if (!parsedRemote) return null;

		this.db
			.update(projects)
			.set({
				repoProvider: parsedRemote.provider,
				repoOwner: parsedRemote.owner,
				repoName: parsedRemote.name,
				repoUrl: parsedRemote.url,
				remoteName,
			})
			.where(eq(projects.id, projectId))
			.run();

		return {
			...parsedRemote,
			remoteName,
		};
	}

	private async fetchRepoPullRequests(
		projectId: string,
		repo: NormalizedRepoIdentity,
		branches: string[],
	): Promise<PullRequestMatchCandidate[]> {
		const octokit = await this.github();
		const nodes = await fetchRepositoryPullRequests(octokit, {
			owner: repo.owner,
			name: repo.name,
		});

		const wantedBranches = new Set(branches);
		const matches: PullRequestMatchCandidate[] = [];
		const now = Date.now();

		for (const node of nodes) {
			if (!wantedBranches.has(node.headRefName)) continue;
			const existing = this.db.query.pullRequests
				.findFirst({
					where: and(
						eq(pullRequests.repoProvider, repo.provider),
						eq(pullRequests.repoOwner, repo.owner),
						eq(pullRequests.repoName, repo.name),
						eq(pullRequests.prNumber, node.number),
					),
				})
				.sync();

			const rowId = existing?.id ?? randomUUID();
			const checks = parseCheckContexts(
				node.statusCheckRollup?.contexts?.nodes ?? [],
			);
			const data = {
				projectId,
				repoProvider: repo.provider,
				repoOwner: repo.owner,
				repoName: repo.name,
				prNumber: node.number,
				url: node.url,
				title: node.title,
				state: mapPullRequestState(node.state, node.isDraft),
				isDraft: node.isDraft,
				headBranch: node.headRefName,
				headSha: node.headRefOid,
				reviewDecision: mapReviewDecision(node.reviewDecision),
				checksStatus: computeChecksStatus(checks),
				checksJson: JSON.stringify(checks),
				lastFetchedAt: now,
				error: null,
				updatedAt: now,
			};

			if (existing) {
				this.db
					.update(pullRequests)
					.set(data)
					.where(eq(pullRequests.id, rowId))
					.run();
			} else {
				this.db
					.insert(pullRequests)
					.values({
						id: rowId,
						createdAt: now,
						...data,
					})
					.run();
			}

			matches.push({ id: rowId, node });
		}

		return matches;
	}

	private findBestPullRequestMatch(
		branch: string,
		headSha: string | null,
		repos: NormalizedRepoIdentity[],
		repoToPullRequests: Map<string, PullRequestMatchCandidate[]>,
	): PullRequestMatchCandidate | null {
		for (const repo of repos) {
			const candidates =
				repoToPullRequests
					.get(getRepoKey(repo))
					?.filter((candidate) =>
						branchMatchesPullRequestHead(
							branch,
							candidate.node.headRefName,
							candidate.node.headRepositoryOwner?.login ?? null,
						),
					) ?? [];
			if (candidates.length === 0) {
				continue;
			}

			candidates.sort((a, b) => comparePullRequestCandidates(a, b, headSha));
			return candidates[0] ?? null;
		}

		return null;
	}
}
