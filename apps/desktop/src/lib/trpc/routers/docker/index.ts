import {
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getProcessEnvWithShellPath } from "../workspaces/utils/shell-env";
import { getWorkspacePath } from "../workspaces/utils/worktree";

const execFileAsync = promisify(execFile);

const COMPOSE_FILE_NAMES = new Set([
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
]);

const IGNORED_DIRECTORIES = new Set([
	".git",
	".next",
	".superset",
	".turbo",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
]);

const SAFE_CONTAINER_ID = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9_.-]+$/u, "Invalid container identifier");

const composeActionInput = z.object({
	workspaceId: z.string(),
	composeFilePath: z.string().min(1),
});

const containerActionInput = z.object({
	workspaceId: z.string(),
	containerId: SAFE_CONTAINER_ID,
});

interface ComposeFileSummary {
	absolutePath: string;
	directoryPath: string;
	projectName: string;
	relativePath: string;
}

interface DockerPsContainerRow {
	Command?: string;
	ID?: string;
	Image?: string;
	Labels?: string;
	Names?: string;
	Ports?: string;
	State?: string;
	Status?: string;
}

interface DockerContainerSummary {
	command: string;
	composeFilePaths: string[];
	id: string;
	image: string;
	name: string;
	ports: string;
	service: string | null;
	state: string;
	status: string;
}

function normalizeExecError(error: unknown): never {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Docker CLI が見つかりません。Docker Desktop または docker CLI をインストールしてください。",
		});
	}

	const stderr =
		typeof error === "object" &&
		error !== null &&
		"stderr" in error &&
		typeof error.stderr === "string"
			? error.stderr.trim()
			: "";

	throw new TRPCError({
		code: "BAD_REQUEST",
		message:
			stderr.length > 0
				? stderr
				: error instanceof Error
					? error.message
					: "Docker command failed",
	});
}

async function execDocker(
	args: string[],
	options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">,
): Promise<string> {
	const env = await getProcessEnvWithShellPath(
		options?.env ? { ...process.env, ...options.env } : process.env,
	);

	const { stdout } = await execFileAsync("docker", args, {
		...options,
		encoding: "utf8",
		env,
		maxBuffer: 8 * 1024 * 1024,
	});

	return stdout;
}

function parseLabelString(labelString: string): Record<string, string> {
	if (!labelString.trim()) {
		return {};
	}

	const labels: Record<string, string> = {};
	for (const part of labelString.split(",")) {
		const separatorIndex = part.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const key = part.slice(0, separatorIndex).trim();
		const value = part.slice(separatorIndex + 1).trim();
		if (key.length > 0) {
			labels[key] = value;
		}
	}

	return labels;
}

function parseDockerPsJsonLines(stdout: string): DockerPsContainerRow[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as DockerPsContainerRow);
}

function mapContainerSummary(
	row: DockerPsContainerRow,
): DockerContainerSummary {
	const labels = parseLabelString(row.Labels ?? "");
	const composeFilePaths = (
		labels["com.docker.compose.project.config_files"] ?? ""
	)
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return {
		command: row.Command ?? "",
		composeFilePaths,
		id: row.ID ?? "",
		image: row.Image ?? "",
		name: row.Names ?? "",
		ports: row.Ports ?? "",
		service: labels["com.docker.compose.service"] ?? null,
		state: row.State ?? "unknown",
		status: row.Status ?? "",
	};
}

function isIgnoredDirectory(name: string): boolean {
	return IGNORED_DIRECTORIES.has(name);
}

async function findComposeFiles(
	rootPath: string,
): Promise<ComposeFileSummary[]> {
	const queue: string[] = [rootPath];
	const composeFiles: ComposeFileSummary[] = [];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		if (!currentDir) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}

			const absolutePath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (isIgnoredDirectory(entry.name)) {
					continue;
				}
				queue.push(absolutePath);
				continue;
			}

			if (!entry.isFile() || !COMPOSE_FILE_NAMES.has(entry.name)) {
				continue;
			}

			const directoryPath = path.dirname(absolutePath);
			const relativePath = path.relative(rootPath, absolutePath) || entry.name;

			composeFiles.push({
				absolutePath,
				directoryPath,
				projectName: path.basename(directoryPath),
				relativePath,
			});
		}
	}

	return composeFiles.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	);
}

function getWorkspaceRootPath(workspaceId: string): string {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();

	if (!workspace) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Workspace ${workspaceId} not found`,
		});
	}

	const workspaceRoot = getWorkspacePath(workspace);
	if (!workspaceRoot) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Workspace path is unavailable",
		});
	}

	return workspaceRoot;
}

async function resolveComposeFileForWorkspace(
	workspaceId: string,
	composeFilePath: string,
): Promise<ComposeFileSummary> {
	const workspaceRoot = getWorkspaceRootPath(workspaceId);
	const composeFiles = await findComposeFiles(workspaceRoot);
	const composeFile = composeFiles.find(
		(entry) => entry.absolutePath === composeFilePath,
	);

	if (!composeFile) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Selected compose file does not belong to this workspace",
		});
	}

	return composeFile;
}

async function assertContainerBelongsToWorkspace(
	workspaceId: string,
	containerId: string,
): Promise<void> {
	const workspaceRoot = getWorkspaceRootPath(workspaceId);
	const composeFiles = await findComposeFiles(workspaceRoot);
	const composeFilePaths = new Set(
		composeFiles.map((composeFile) => composeFile.absolutePath),
	);

	const stdout = await execDocker(["ps", "-a", "--format", "json"], {
		cwd: workspaceRoot,
	});
	const container = parseDockerPsJsonLines(stdout)
		.map(mapContainerSummary)
		.find((entry) => entry.id === containerId);

	if (
		!container ||
		!container.composeFilePaths.some((composeFilePath) =>
			composeFilePaths.has(composeFilePath),
		)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Selected container does not belong to this workspace",
		});
	}
}

export const createDockerRouter = () => {
	return router({
		getComposeFiles: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(async ({ input }) => {
				const workspaceRoot = getWorkspaceRootPath(input.workspaceId);
				const composeFiles = await findComposeFiles(workspaceRoot);
				return {
					workspaceRoot,
					composeFiles,
				};
			}),

		list: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(async ({ input }) => {
				const workspaceRoot = getWorkspaceRootPath(input.workspaceId);
				const composeFiles = await findComposeFiles(workspaceRoot);

				if (composeFiles.length === 0) {
					return {
						composeFiles: [],
						dockerAvailable: true,
						dockerError: null,
						workspaceRoot,
					};
				}

				let containers: DockerContainerSummary[] = [];
				let dockerAvailable = true;
				let dockerError: string | null = null;

				try {
					const stdout = await execDocker(["ps", "-a", "--format", "json"]);
					containers = parseDockerPsJsonLines(stdout).map(mapContainerSummary);
				} catch (error) {
					dockerAvailable = false;
					dockerError =
						typeof error === "object" &&
						error !== null &&
						"stderr" in error &&
						typeof error.stderr === "string" &&
						error.stderr.trim().length > 0
							? error.stderr.trim()
							: error instanceof Error
								? error.message
								: "Failed to read Docker containers";
				}

				return {
					composeFiles: composeFiles.map((composeFile) => {
						const matchingContainers = containers
							.filter((container) =>
								container.composeFilePaths.includes(composeFile.absolutePath),
							)
							.sort((left, right) => {
								const leftKey = `${left.service ?? ""}:${left.name}`;
								const rightKey = `${right.service ?? ""}:${right.name}`;
								return leftKey.localeCompare(rightKey);
							});

						return {
							...composeFile,
							containers: matchingContainers,
							runningContainers: matchingContainers.filter(
								(container) => container.state === "running",
							).length,
							totalContainers: matchingContainers.length,
						};
					}),
					dockerAvailable,
					dockerError,
					workspaceRoot,
				};
			}),

		startProject: publicProcedure
			.input(composeActionInput)
			.mutation(async ({ input }) => {
				const composeFile = await resolveComposeFileForWorkspace(
					input.workspaceId,
					input.composeFilePath,
				);

				try {
					await execDocker(
						["compose", "-f", composeFile.absolutePath, "up", "-d"],
						{ cwd: composeFile.directoryPath },
					);
					return { success: true };
				} catch (error) {
					normalizeExecError(error);
				}
			}),

		stopProject: publicProcedure
			.input(composeActionInput)
			.mutation(async ({ input }) => {
				const composeFile = await resolveComposeFileForWorkspace(
					input.workspaceId,
					input.composeFilePath,
				);

				try {
					await execDocker(
						["compose", "-f", composeFile.absolutePath, "stop"],
						{
							cwd: composeFile.directoryPath,
						},
					);
					return { success: true };
				} catch (error) {
					normalizeExecError(error);
				}
			}),

		startContainer: publicProcedure
			.input(containerActionInput)
			.mutation(async ({ input }) => {
				try {
					await assertContainerBelongsToWorkspace(
						input.workspaceId,
						input.containerId,
					);
					await execDocker(["container", "start", input.containerId], {
						cwd: getWorkspaceRootPath(input.workspaceId),
					});
					return { success: true };
				} catch (error) {
					normalizeExecError(error);
				}
			}),

		stopContainer: publicProcedure
			.input(containerActionInput)
			.mutation(async ({ input }) => {
				try {
					await assertContainerBelongsToWorkspace(
						input.workspaceId,
						input.containerId,
					);
					await execDocker(["container", "stop", input.containerId], {
						cwd: getWorkspaceRootPath(input.workspaceId),
					});
					return { success: true };
				} catch (error) {
					normalizeExecError(error);
				}
			}),

		restartContainer: publicProcedure
			.input(containerActionInput)
			.mutation(async ({ input }) => {
				try {
					await assertContainerBelongsToWorkspace(
						input.workspaceId,
						input.containerId,
					);
					await execDocker(["container", "restart", input.containerId], {
						cwd: getWorkspaceRootPath(input.workspaceId),
					});
					return { success: true };
				} catch (error) {
					normalizeExecError(error);
				}
			}),

		inspectContainer: publicProcedure
			.input(containerActionInput)
			.query(async ({ input }) => {
				try {
					await assertContainerBelongsToWorkspace(
						input.workspaceId,
						input.containerId,
					);
					const stdout = await execDocker(
						["container", "inspect", "--format", "json", input.containerId],
						{ cwd: getWorkspaceRootPath(input.workspaceId) },
					);
					return JSON.parse(stdout) as unknown;
				} catch (error) {
					normalizeExecError(error);
				}
			}),
	});
};

export type DockerRouter = ReturnType<typeof createDockerRouter>;
