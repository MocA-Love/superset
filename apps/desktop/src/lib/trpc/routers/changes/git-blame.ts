import { z } from "zod";
import { publicProcedure, router } from "../..";
import { toRegisteredWorktreeRelativePath } from "../workspace-fs-service";
import { getSimpleGitWithShellPath } from "../workspaces/utils/git-client";
import { assertRegisteredWorktree } from "./security/path-validation";

export interface BlameEntry {
	line: number;
	commitHash: string;
	author: string;
	timestamp: number;
	summary: string;
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
	});
};
