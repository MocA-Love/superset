import {
	type BranchPrefixMode,
	resolveBranchPrefix,
} from "@superset/shared/workspace-launch";
import type { SimpleGit } from "simple-git";
import { hostSettings } from "../../../../db/schema";
import type { HostServiceContext } from "../../../../types";
import type { LocalProject } from "../shared/local-project";
import type { ExecGh } from "./exec-gh";

export async function getGitAuthorName(git: SimpleGit): Promise<string | null> {
	try {
		const name = await git.getConfig("user.name");
		return name.value?.trim() || null;
	} catch (error) {
		console.warn("[branch-prefix] failed to read git user.name:", error);
		return null;
	}
}

export async function getGitHubUsername(
	execGh: ExecGh,
): Promise<string | null> {
	try {
		const result = await execGh(["api", "user", "--jq", ".login"]);
		return typeof result === "string" && result.trim() ? result.trim() : null;
	} catch (error) {
		console.warn("[branch-prefix] failed to read GitHub username:", error);
		return null;
	}
}

export interface ResolvedGitInfo {
	githubUsername: string | null;
	authorName: string | null;
}

export async function resolveGitInfo(
	git: SimpleGit,
	execGh: ExecGh,
): Promise<ResolvedGitInfo> {
	const [githubUsername, authorName] = await Promise.all([
		getGitHubUsername(execGh),
		getGitAuthorName(git),
	]);
	return { githubUsername, authorName };
}

export async function resolveProjectBranchPrefix({
	ctx,
	project,
	git,
	existingBranches,
}: {
	ctx: HostServiceContext;
	project: LocalProject;
	git: SimpleGit;
	existingBranches: string[];
}): Promise<string | undefined> {
	const global = ctx.db.select().from(hostSettings).get();
	const source = project.branchPrefixMode != null ? project : global;
	const mode: BranchPrefixMode = source?.branchPrefixMode ?? "none";
	const customPrefix = source?.branchPrefixCustom ?? null;

	if (mode === "none") return undefined;

	let authorName: string | null = null;
	let githubUsername: string | null = null;
	if (mode === "author") {
		authorName = await getGitAuthorName(git);
	} else if (mode === "github") {
		[githubUsername, authorName] = await Promise.all([
			getGitHubUsername(ctx.execGh),
			getGitAuthorName(git),
		]);
	}

	const prefix = resolveBranchPrefix({
		mode,
		customPrefix,
		authorPrefix: authorName,
		githubUsername,
	});
	if (!prefix) return undefined;

	const existingSet = new Set(
		existingBranches.map((branch) => branch.toLowerCase()),
	);
	return existingSet.has(prefix.toLowerCase()) ? undefined : prefix;
}
