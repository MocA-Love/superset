import { execGitWithShellPath } from "../git-client";
import { execWithShellEnv } from "../shell-env";
import { parseUpstreamRef } from "../upstream-ref";
import { getCachedRepoContextState, readCachedRepoContext } from "./cache";
import { GHRepoResponseSchema, type RepoContext } from "./types";

async function refreshRepoContext(
	worktreePath: string,
): Promise<RepoContext | null> {
	try {
		const { stdout } = await execWithShellEnv(
			"gh",
			["repo", "view", "--json", "url,isFork,parent"],
			{ cwd: worktreePath },
		);
		const raw: unknown = JSON.parse(stdout);
		const result = GHRepoResponseSchema.safeParse(raw);
		if (!result.success) {
			console.error("[GitHub] Repo schema validation failed:", result.error);
			console.error("[GitHub] Raw data:", JSON.stringify(raw, null, 2));
			return null;
		}

		const data = result.data;
		let context: RepoContext | undefined;

		if (data.isFork && data.parent) {
			const upstreamUrl =
				data.parent.url ??
				(data.parent.owner?.login && data.parent.name
					? `https://github.com/${data.parent.owner.login}/${data.parent.name}`
					: null);

			if (upstreamUrl) {
				context = { repoUrl: data.url, upstreamUrl, isFork: true };
			}
		}

		if (!context) {
			const originUrl = await getOriginUrl(worktreePath);
			const ghUrl = normalizeGitHubUrl(data.url);

			if (originUrl && ghUrl && originUrl !== ghUrl) {
				context = {
					repoUrl: originUrl,
					upstreamUrl: ghUrl,
					isFork: true,
				};
			} else if (data.isFork) {
				// Fork but upstream URL could not be determined — surface as error
				// rather than silently treating as non-fork (which would misdirect PRs)
				console.warn(
					"[GitHub] Fork detected but upstream URL could not be resolved",
					{ url: data.url },
				);
				return null;
			} else {
				context = {
					repoUrl: data.url,
					upstreamUrl: data.url,
					isFork: false,
				};
			}
		}

		return context;
	} catch (error) {
		console.warn("[GitHub] Failed to refresh repo context:", error);
		return null;
	}
}

export async function getRepoContext(
	worktreePath: string,
	options?: {
		forceFresh?: boolean;
	},
): Promise<RepoContext | null> {
	const originUrl = await getOriginUrl(worktreePath);
	const cachedRepoContext =
		getCachedRepoContextState(worktreePath)?.value ?? null;
	const forceFresh =
		Boolean(options?.forceFresh) ||
		shouldRefreshCachedRepoContext({
			originUrl,
			cachedRepoContext,
		});

	return readCachedRepoContext(
		worktreePath,
		() => refreshRepoContext(worktreePath),
		{
			forceFresh,
		},
	);
}

export function shouldRefreshCachedRepoContext({
	originUrl,
	cachedRepoContext,
}: {
	originUrl: string | null;
	cachedRepoContext: RepoContext | null;
}): boolean {
	if (!cachedRepoContext) {
		return true;
	}

	const normalizedOriginUrl = normalizeGitHubUrl(
		originUrl ?? "",
	)?.toLowerCase();
	const normalizedCachedRepoUrl = normalizeGitHubUrl(
		cachedRepoContext.repoUrl,
	)?.toLowerCase();

	if (!normalizedOriginUrl || !normalizedCachedRepoUrl) {
		return false;
	}

	return normalizedCachedRepoUrl !== normalizedOriginUrl;
}

async function getOriginUrl(worktreePath: string): Promise<string | null> {
	try {
		return getRemoteUrl(worktreePath, "origin");
	} catch {
		return null;
	}
}

async function getRemoteUrl(
	worktreePath: string,
	remoteName: string,
): Promise<string | null> {
	try {
		const { stdout } = await execGitWithShellPath(
			["remote", "get-url", remoteName],
			{ cwd: worktreePath },
		);
		return normalizeGitHubUrl(stdout.trim());
	} catch {
		return null;
	}
}

export function normalizeGitHubUrl(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim();
	const patterns = [
		/^git@github\.com:(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/,
		/^https:\/\/github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?\/?$/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(trimmed);
		if (match?.groups?.nwo) {
			return `https://github.com/${match.groups.nwo}`;
		}
	}
	return null;
}

export function extractNwoFromUrl(normalizedUrl: string): string | null {
	try {
		const segments = new URL(normalizedUrl).pathname.split("/").filter(Boolean);
		if (segments.length < 2) {
			return null;
		}
		return `${segments[0]}/${segments[1]}`;
	} catch {
		return null;
	}
}

export function getPullRequestRepoNames(
	repoContext?: Pick<RepoContext, "repoUrl" | "upstreamUrl" | "isFork"> | null,
): string[] {
	if (!repoContext) {
		return [];
	}

	const candidates = [
		repoContext.repoUrl,
		repoContext.isFork ? repoContext.upstreamUrl : null,
	];

	return Array.from(
		new Set(
			candidates
				.map((candidate) => normalizeGitHubUrl(candidate ?? ""))
				.filter((candidate): candidate is string => Boolean(candidate))
				.map((candidate) => extractNwoFromUrl(candidate))
				.filter((candidate): candidate is string => Boolean(candidate)),
		),
	);
}

export async function getTrackingRepoUrl(
	worktreePath: string,
): Promise<string | null> {
	try {
		const { stdout } = await execGitWithShellPath(
			["rev-parse", "--abbrev-ref", "@{upstream}"],
			{ cwd: worktreePath },
		);
		const parsed = parseUpstreamRef(stdout.trim());
		if (!parsed) {
			return null;
		}

		return getRemoteUrl(worktreePath, parsed.remoteName);
	} catch {
		return null;
	}
}

export async function getPullRequestRepoNamesForWorktree({
	worktreePath,
	repoContext,
}: {
	worktreePath: string;
	repoContext?: Pick<RepoContext, "repoUrl" | "upstreamUrl" | "isFork"> | null;
}): Promise<string[]> {
	const [resolvedRepoContext, trackingRepoUrl] = await Promise.all([
		repoContext ? Promise.resolve(repoContext) : getRepoContext(worktreePath),
		getTrackingRepoUrl(worktreePath),
	]);

	const candidates = [
		trackingRepoUrl,
		...getPullRequestRepoNames(resolvedRepoContext),
	];

	return Array.from(
		new Set(
			candidates
				.map((candidate) => normalizeGitHubUrl(candidate ?? ""))
				.filter((candidate): candidate is string => Boolean(candidate))
				.map((candidate) => extractNwoFromUrl(candidate))
				.filter((candidate): candidate is string => Boolean(candidate)),
		),
	);
}

export function getPullRequestRepoArgs(
	repoContext?: Pick<RepoContext, "isFork" | "upstreamUrl"> | null,
): string[] {
	if (!repoContext?.isFork) {
		return [];
	}

	const normalizedUpstreamUrl = normalizeGitHubUrl(repoContext.upstreamUrl);
	if (!normalizedUpstreamUrl) {
		return [];
	}

	const repoNameWithOwner = extractNwoFromUrl(normalizedUpstreamUrl);
	return repoNameWithOwner ? ["--repo", repoNameWithOwner] : [];
}
