import { z } from "zod";
import { publicProcedure, router } from "../..";
import { toRegisteredWorktreeRelativePath } from "../workspace-fs-service";
import { getSimpleGitWithShellPath } from "../workspaces/utils/git-client";
import { execWithShellEnv } from "../workspaces/utils/shell-env";
import {
	makeGitHubCommitAuthorCacheKey,
	type GitHubCommitAuthor,
	readCachedGitHubCommitAuthor,
} from "../workspaces/utils/github/cache";
import {
	extractNwoFromUrl,
	getRepoContext,
} from "../workspaces/utils/github/repo-context";
import { assertRegisteredWorktree } from "./security/path-validation";

export interface BlameEntry {
	line: number;
	commitHash: string;
	author: string;
	timestamp: number;
	summary: string;
}

const GitHubCommitResponseSchema = z.object({
	author: z
		.object({
			login: z.string().optional(),
			avatar_url: z.string().optional(),
		})
		.nullable()
		.optional(),
});

function isSafeAvatarUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function parseJsonOrNull(stdout: string): unknown | null {
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		return null;
	}
}

function getRepoCandidates(
	repoContext: Awaited<ReturnType<typeof getRepoContext>>,
): string[] {
	if (!repoContext) {
		return [];
	}

	return Array.from(
		new Set(
			[repoContext.repoUrl, repoContext.upstreamUrl]
				.map((url) => extractNwoFromUrl(url))
				.filter((value): value is string => Boolean(value)),
		),
	);
}

async function fetchGitHubCommitAuthorForRepo({
	worktreePath,
	repoNameWithOwner,
	commitHash,
}: {
	worktreePath: string;
	repoNameWithOwner: string;
	commitHash: string;
}): Promise<GitHubCommitAuthor | null> {
	const cacheKey = makeGitHubCommitAuthorCacheKey({
		repoNameWithOwner,
		commitHash,
	});

	return readCachedGitHubCommitAuthor(cacheKey, async () => {
		try {
			const { stdout } = await execWithShellEnv(
				"gh",
				["api", `repos/${repoNameWithOwner}/commits/${commitHash}`],
				{ cwd: worktreePath },
			);
			const raw = parseJsonOrNull(stdout);
			if (raw === null) {
				return null;
			}

			const parsed = GitHubCommitResponseSchema.safeParse(raw);
			if (!parsed.success) {
				return null;
			}

			const login = parsed.data.author?.login?.trim() || null;
			const avatarUrl =
				parsed.data.author?.avatar_url &&
				isSafeAvatarUrl(parsed.data.author.avatar_url)
					? parsed.data.author.avatar_url
					: null;

			if (!login && !avatarUrl) {
				return null;
			}

			return { login, avatarUrl };
		} catch {
			return null;
		}
	});
}

async function getGitHubCommitAuthor({
	worktreePath,
	commitHash,
}: {
	worktreePath: string;
	commitHash: string;
}): Promise<GitHubCommitAuthor | null> {
	const repoContext = await getRepoContext(worktreePath);

	for (const repoNameWithOwner of getRepoCandidates(repoContext)) {
		const author = await fetchGitHubCommitAuthorForRepo({
			worktreePath,
			repoNameWithOwner,
			commitHash,
		});
		if (author) {
			return author;
		}
	}

	return null;
}

function parseGitBlamePorcelain(output: string): BlameEntry[] {
	const lines = output.split("\n");
	const commitCache = new Map<
		string,
		{ author: string; timestamp: number; summary: string }
	>();
	const result: BlameEntry[] = [];

	let i = 0;
	while (i < lines.length) {
		const header = lines[i];
		if (!header || header.length < 40) {
			i++;
			continue;
		}

		const commitHash = header.substring(0, 40);
		if (!/^[0-9a-f]{40}$/.test(commitHash)) {
			i++;
			continue;
		}

		const parts = header.split(" ");
		const finalLine = Number.parseInt(parts[2] ?? "", 10);

		i++;

		let author = "";
		let timestamp = 0;
		let summary = "";

		if (!commitCache.has(commitHash)) {
			while (i < lines.length && !lines[i].startsWith("\t")) {
				const line = lines[i];
				if (line.startsWith("author ")) {
					author = line.substring(7);
				} else if (line.startsWith("author-time ")) {
					timestamp = Number.parseInt(line.substring(12), 10);
				} else if (line.startsWith("summary ")) {
					summary = line.substring(8);
				}
				i++;
			}
			commitCache.set(commitHash, { author, timestamp, summary });
		} else {
			while (i < lines.length && !lines[i].startsWith("\t")) {
				i++;
			}
			// biome-ignore lint/style/noNonNullAssertion: commitHash is guaranteed to exist in cache at this point
			const cached = commitCache.get(commitHash)!;
			author = cached.author;
			timestamp = cached.timestamp;
			summary = cached.summary;
		}

		// skip the tab+content line
		i++;

		if (!Number.isNaN(finalLine)) {
			result.push({ line: finalLine, commitHash, author, timestamp, summary });
		}
	}

	return result;
}

export const createGitBlameRouter = () => {
	return router({
		getGitBlame: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					absolutePath: z.string(),
				}),
			)
			.query(async ({ input }): Promise<{ entries: BlameEntry[] }> => {
				assertRegisteredWorktree(input.worktreePath);

				const filePath = toRegisteredWorktreeRelativePath(
					input.worktreePath,
					input.absolutePath,
				);

				const git = await getSimpleGitWithShellPath(input.worktreePath);

				try {
					const output = await git.raw([
						"blame",
						"--porcelain",
						"--",
						filePath,
					]);
					return { entries: parseGitBlamePorcelain(output) };
				} catch {
					return { entries: [] };
				}
			}),
		getGitHubCommitAuthor: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					commitHash: z.string().regex(/^[0-9a-f]{40}$/i),
				}),
			)
			.query(async ({ input }): Promise<GitHubCommitAuthor | null> => {
				assertRegisteredWorktree(input.worktreePath);
				return getGitHubCommitAuthor(input);
			}),
	});
};
