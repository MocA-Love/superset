import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as ts from "typescript";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspace } from "../workspaces/utils/db-helpers";
import { getWorkspacePath } from "../workspaces/utils/worktree";

const MAX_PROBLEMS = 500;

const openDocumentSchema = z.object({
	relativePath: z.string(),
	content: z.string().nullable(),
});

const typeScriptProblemSchema = z.object({
	relativePath: z.string().nullable(),
	line: z.number().nullable(),
	column: z.number().nullable(),
	endLine: z.number().nullable(),
	endColumn: z.number().nullable(),
	message: z.string(),
	code: z.union([z.string(), z.number()]).nullable(),
	severity: z.enum(["error", "warning", "info", "hint"]),
	source: z.string(),
});

function resolveConfigPath(workspacePath: string): string | null {
	const tsconfigPath = path.join(workspacePath, "tsconfig.json");
	if (ts.sys.fileExists(tsconfigPath)) {
		return tsconfigPath;
	}

	const jsconfigPath = path.join(workspacePath, "jsconfig.json");
	if (ts.sys.fileExists(jsconfigPath)) {
		return jsconfigPath;
	}

	return null;
}

function findNearestConfigPath(
	workspacePath: string,
	relativePath: string,
): string | null {
	let currentDirectory = path.resolve(
		workspacePath,
		path.dirname(relativePath),
	);
	const normalizedWorkspacePath = path.resolve(workspacePath);

	while (true) {
		const tsconfigPath = path.join(currentDirectory, "tsconfig.json");
		if (ts.sys.fileExists(tsconfigPath)) {
			return tsconfigPath;
		}

		const jsconfigPath = path.join(currentDirectory, "jsconfig.json");
		if (ts.sys.fileExists(jsconfigPath)) {
			return jsconfigPath;
		}

		if (currentDirectory === normalizedWorkspacePath) {
			return null;
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return null;
		}

		currentDirectory = parentDirectory;
	}
}

function mapSeverity(
	category: ts.DiagnosticCategory,
): "error" | "warning" | "info" | "hint" {
	switch (category) {
		case ts.DiagnosticCategory.Error:
			return "error";
		case ts.DiagnosticCategory.Warning:
			return "warning";
		case ts.DiagnosticCategory.Suggestion:
			return "hint";
		default:
			return "info";
	}
}

function normalizeRelativePath(
	workspacePath: string,
	fileName: string,
): string | null {
	const relativePath = path.relative(workspacePath, fileName);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		path.isAbsolute(relativePath)
	) {
		return null;
	}

	return relativePath.split(path.sep).join("/");
}

function diagnosticSortValue(severity: string): number {
	switch (severity) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		default:
			return 3;
	}
}

function createOpenDocumentMap(
	workspacePath: string,
	openDocuments: Array<{ relativePath: string; content: string | null }>,
): Map<string, string> {
	return new Map(
		openDocuments
			.filter((document) => document.content !== null)
			.map((document) => [
				path.resolve(workspacePath, document.relativePath),
				document.content,
			]),
	);
}

function createCompilerHostWithOpenDocuments(
	options: ts.CompilerOptions,
	openDocumentMap: Map<string, string>,
): ts.CompilerHost {
	const compilerHost = ts.createCompilerHost(options, true);
	const originalReadFile = compilerHost.readFile.bind(compilerHost);
	const originalFileExists = compilerHost.fileExists.bind(compilerHost);
	const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);

	compilerHost.readFile = (fileName) => {
		const override = openDocumentMap.get(path.resolve(fileName));
		if (override !== undefined) {
			return override;
		}

		return originalReadFile(fileName);
	};

	compilerHost.fileExists = (fileName) => {
		if (openDocumentMap.has(path.resolve(fileName))) {
			return true;
		}

		return originalFileExists(fileName);
	};

	compilerHost.getSourceFile = (
		fileName,
		languageVersionOrOptions,
		onError,
		shouldCreateNewSourceFile,
	) => {
		const override = openDocumentMap.get(path.resolve(fileName));
		if (override !== undefined) {
			return ts.createSourceFile(
				fileName,
				override,
				languageVersionOrOptions,
				true,
			);
		}

		return originalGetSourceFile(
			fileName,
			languageVersionOrOptions,
			onError,
			shouldCreateNewSourceFile,
		);
	};

	return compilerHost;
}

function getStandaloneCompilerOptions(filePath: string): ts.CompilerOptions {
	const extension = path.extname(filePath).toLowerCase();
	return {
		noEmit: true,
		allowJs: [".js", ".jsx", ".mjs", ".cjs"].includes(extension),
		checkJs: [".js", ".jsx", ".mjs", ".cjs"].includes(extension),
		jsx: [".jsx", ".tsx"].includes(extension) ? ts.JsxEmit.Preserve : undefined,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		skipLibCheck: true,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	};
}

function createProblemKey(problem: {
	relativePath: string | null;
	line: number | null;
	column: number | null;
	message: string;
	code: string | number | null;
	severity: string;
	source: string;
}): string {
	return [
		problem.relativePath ?? "workspace",
		problem.line ?? 0,
		problem.column ?? 0,
		problem.code ?? "no-code",
		problem.severity,
		problem.source,
		problem.message,
	].join("::");
}

function mapDiagnosticsToProblems(
	diagnostics: readonly ts.Diagnostic[],
	workspacePath: string,
) {
	return diagnostics
		.map((diagnostic) => {
			const message = ts.flattenDiagnosticMessageText(
				diagnostic.messageText,
				"\n",
			);
			const severity = mapSeverity(diagnostic.category);
			const relativePath = diagnostic.file?.fileName
				? normalizeRelativePath(workspacePath, diagnostic.file.fileName)
				: null;

			if (diagnostic.file?.fileName && relativePath === null) {
				return null;
			}

			const start =
				diagnostic.file && typeof diagnostic.start === "number"
					? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
					: null;
			const end =
				diagnostic.file &&
				typeof diagnostic.start === "number" &&
				typeof diagnostic.length === "number"
					? diagnostic.file.getLineAndCharacterOfPosition(
							diagnostic.start + diagnostic.length,
						)
					: null;

			return {
				relativePath,
				line: start ? start.line + 1 : null,
				column: start ? start.character + 1 : null,
				endLine: end ? end.line + 1 : null,
				endColumn: end ? end.character + 1 : null,
				message,
				code: diagnostic.code ?? null,
				severity,
				source: "typescript",
			};
		})
		.filter(
			(problem): problem is NonNullable<typeof problem> => problem !== null,
		);
}

function filterProblemsForOpenDocuments(
	problems: Array<z.infer<typeof typeScriptProblemSchema>>,
	openDocuments: Array<{ relativePath: string; content: string | null }>,
) {
	if (openDocuments.length === 0) {
		return problems;
	}

	const openDocumentPaths = new Set(
		openDocuments.map((document) => document.relativePath),
	);

	return problems.filter((problem) => {
		if (problem.relativePath === null) {
			return false;
		}

		return openDocumentPaths.has(problem.relativePath);
	});
}

export const createDiagnosticsRouter = () => {
	return router({
		getTypeScriptProblems: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					openDocuments: z.array(openDocumentSchema).default([]),
				}),
			)
			.output(
				z.object({
					status: z.enum(["ready", "no-config"]),
					workspacePath: z.string(),
					configPath: z.string().nullable(),
					problems: z.array(typeScriptProblemSchema),
					totalCount: z.number(),
					truncated: z.boolean(),
					summary: z.object({
						errorCount: z.number(),
						warningCount: z.number(),
						infoCount: z.number(),
						hintCount: z.number(),
					}),
				}),
			)
			.query(({ input }) => {
				const workspace = getWorkspace(input.workspaceId);
				if (!workspace) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Workspace ${input.workspaceId} not found`,
					});
				}

				const workspacePath = getWorkspacePath(workspace);
				if (!workspacePath) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Workspace ${input.workspaceId} has no filesystem path`,
					});
				}

				const rootConfigPath = resolveConfigPath(workspacePath);
				const configPaths = new Set<string>();
				const standaloneFiles: string[] = [];
				const openDocumentMap = createOpenDocumentMap(
					workspacePath,
					input.openDocuments,
				);

				if (input.openDocuments.length > 0) {
					for (const document of input.openDocuments) {
						const configPath = findNearestConfigPath(
							workspacePath,
							document.relativePath,
						);
						if (configPath) {
							configPaths.add(configPath);
						} else {
							standaloneFiles.push(
								path.resolve(workspacePath, document.relativePath),
							);
						}
					}
				} else if (rootConfigPath) {
					configPaths.add(rootConfigPath);
				}

				if (configPaths.size === 0 && standaloneFiles.length === 0) {
					console.log("[diagnostics] no config found", {
						workspaceId: input.workspaceId,
						workspacePath,
						openDocuments: input.openDocuments.map(
							(document) => document.relativePath,
						),
					});
					return {
						status: "no-config" as const,
						workspacePath,
						configPath: null,
						problems: [],
						totalCount: 0,
						truncated: false,
						summary: {
							errorCount: 0,
							warningCount: 0,
							infoCount: 0,
							hintCount: 0,
						},
					};
				}

				const collectedProblems = new Map<
					string,
					z.infer<typeof typeScriptProblemSchema>
				>();
				const configPathList = Array.from(configPaths);

				console.log("[diagnostics] target documents", {
					workspaceId: input.workspaceId,
					workspacePath,
					openDocuments: input.openDocuments.map((document) => ({
						relativePath: document.relativePath,
						hasOverride: document.content !== null,
					})),
					configPaths: configPathList,
					standaloneFiles: standaloneFiles.map((filePath) =>
						normalizeRelativePath(workspacePath, filePath),
					),
				});

				for (const configPath of configPathList) {
					const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
					if (configFile.error) {
						const problem = {
							relativePath: normalizeRelativePath(workspacePath, configPath),
							line: null,
							column: null,
							endLine: null,
							endColumn: null,
							message: ts.flattenDiagnosticMessageText(
								configFile.error.messageText,
								"\n",
							),
							code: configFile.error.code,
							severity: mapSeverity(configFile.error.category),
							source: "typescript",
						};
						collectedProblems.set(createProblemKey(problem), problem);
						continue;
					}

					const parsedConfig = ts.parseJsonConfigFileContent(
						configFile.config,
						ts.sys,
						path.dirname(configPath),
						{ noEmit: true },
						configPath,
					);
					const configOpenFiles = input.openDocuments
						.filter(
							(document) =>
								findNearestConfigPath(workspacePath, document.relativePath) ===
								configPath,
						)
						.map((document) =>
							path.resolve(workspacePath, document.relativePath),
						);
					const rootNames = Array.from(
						new Set([...parsedConfig.fileNames, ...configOpenFiles]),
					);
					console.log("[diagnostics] parsed config", {
						workspaceId: input.workspaceId,
						workspacePath,
						configPath,
						openDocumentCount: input.openDocuments.length,
						rootFileCount: rootNames.length,
						sampleRootFiles: rootNames
							.slice(0, 20)
							.map((fileName) =>
								normalizeRelativePath(workspacePath, fileName),
							),
					});

					const compilerHost = createCompilerHostWithOpenDocuments(
						parsedConfig.options,
						openDocumentMap,
					);
					const program = ts.createProgram({
						rootNames,
						options: parsedConfig.options,
						projectReferences: parsedConfig.projectReferences,
						host: compilerHost,
					});
					const diagnostics = [
						...parsedConfig.errors,
						...ts.getPreEmitDiagnostics(program),
					];
					for (const problem of mapDiagnosticsToProblems(
						diagnostics,
						workspacePath,
					)) {
						collectedProblems.set(createProblemKey(problem), problem);
					}
				}

				for (const standaloneFilePath of standaloneFiles) {
					const compilerOptions =
						getStandaloneCompilerOptions(standaloneFilePath);
					const compilerHost = createCompilerHostWithOpenDocuments(
						compilerOptions,
						openDocumentMap,
					);
					const program = ts.createProgram({
						rootNames: [standaloneFilePath],
						options: compilerOptions,
						host: compilerHost,
					});
					for (const problem of mapDiagnosticsToProblems(
						ts.getPreEmitDiagnostics(program),
						workspacePath,
					)) {
						collectedProblems.set(createProblemKey(problem), problem);
					}
				}

				const mappedProblems = filterProblemsForOpenDocuments(
					Array.from(collectedProblems.values()),
					input.openDocuments,
				).sort((left, right) => {
					const severityDiff =
						diagnosticSortValue(left.severity) -
						diagnosticSortValue(right.severity);
					if (severityDiff !== 0) {
						return severityDiff;
					}

					const pathDiff = (left.relativePath ?? "").localeCompare(
						right.relativePath ?? "",
					);
					if (pathDiff !== 0) {
						return pathDiff;
					}
					return (left.line ?? 0) - (right.line ?? 0);
				});

				const summary = mappedProblems.reduce(
					(acc, problem) => {
						if (problem.severity === "error") acc.errorCount += 1;
						if (problem.severity === "warning") acc.warningCount += 1;
						if (problem.severity === "info") acc.infoCount += 1;
						if (problem.severity === "hint") acc.hintCount += 1;
						return acc;
					},
					{
						errorCount: 0,
						warningCount: 0,
						infoCount: 0,
						hintCount: 0,
					},
				);

				console.log("[diagnostics] result", {
					workspaceId: input.workspaceId,
					configPaths: configPathList,
					totalCount: mappedProblems.length,
					problemFiles: Array.from(
						new Set(
							mappedProblems.map(
								(problem) => problem.relativePath ?? "Workspace",
							),
						),
					),
				});

				return {
					status: "ready" as const,
					workspacePath,
					configPath: configPathList.length === 1 ? configPathList[0] : null,
					problems: mappedProblems.slice(0, MAX_PROBLEMS),
					totalCount: mappedProblems.length,
					truncated: mappedProblems.length > MAX_PROBLEMS,
					summary,
				};
			}),
	});
};

export type DiagnosticsRouter = ReturnType<typeof createDiagnosticsRouter>;
