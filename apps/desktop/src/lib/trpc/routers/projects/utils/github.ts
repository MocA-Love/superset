import { execGitWithShellPath } from "../../workspaces/utils/git-client";
import { execWithShellEnv } from "../../workspaces/utils/shell-env";

function parseGitHubOwnerFromRemoteUrl(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim();
	const patterns = [
		/^git@github\.com:(?<owner>[^/]+)\/[^/]+?(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/[^/]+?(?:\.git)?$/,
		/^https:\/\/github\.com\/(?<owner>[^/]+)\/[^/]+?(?:\.git)?\/?$/,
	];

	for (const pattern of patterns) {
		const match = pattern.exec(trimmed);
		if (match?.groups?.owner) {
			return match.groups.owner;
		}
	}

	return null;
}

/**
 * Fetches the GitHub owner (user or org) for a repository using the `gh` CLI.
 * Returns null if `gh` is not installed, not authenticated, or on error.
 */
export async function fetchGitHubOwner(
	repoPath: string,
): Promise<string | null> {
	try {
		const { stdout } = await execGitWithShellPath(
			["remote", "get-url", "origin"],
			{
				cwd: repoPath,
			},
		);
		const owner = parseGitHubOwnerFromRemoteUrl(stdout);
		if (owner) {
			return owner;
		}
	} catch {
		// Fall back to gh when no origin remote exists or the remote is not GitHub.
	}

	try {
		const { stdout } = await execWithShellEnv(
			"gh",
			["repo", "view", "--jq", ".owner.login"],
			{ cwd: repoPath },
		);
		const owner = stdout.trim();
		return owner || null;
	} catch {
		return null;
	}
}

/**
 * Constructs the GitHub avatar URL for a user or organization.
 * GitHub serves avatars at https://github.com/{owner}.png
 */
export function getGitHubAvatarUrl(owner: string): string {
	return `https://github.com/${owner}.png`;
}
