import { spawnSync } from "node:child_process";
import path from "node:path";
import { languageDiagnosticsStore } from "../../diagnostics-store";
import { StdioJsonRpcClient } from "../../lsp/StdioJsonRpcClient";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
	LanguageServiceRelatedInformation,
} from "../../types";
import {
	absolutePathToFileUri,
	fileUriToAbsolutePath,
	lspSeverityToLanguageServiceSeverity,
	offsetToLspPosition,
	toRelativeWorkspacePath,
} from "../../utils";

type OpenDocumentEntry = {
	languageId: string;
	version: number;
	content: string;
	uri: string;
};

type DartDiagnostic = {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
	relatedInformation?: Array<{
		location: {
			uri: string;
			range: {
				start: { line: number; character: number };
				end: { line: number; character: number };
			};
		};
		message: string;
	}>;
};

type WorkspaceSession = {
	workspaceId: string;
	workspacePath: string;
	dartCommand: string;
	client: StdioJsonRpcClient;
	openDocuments: Map<string, OpenDocumentEntry>;
	lastError: string | null;
	textDocumentSyncMode: "full" | "incremental";
};

type ResolvedDartCommand = {
	command: string;
	shell: boolean;
};

function canExecute(command: string, shell: boolean): boolean {
	const probe = spawnSync(command, ["--version"], {
		stdio: "ignore",
		shell,
	});
	return probe.status === 0;
}

function getEnvCandidateCommands(): string[] {
	const executableName = process.platform === "win32" ? "dart.exe" : "dart";
	const wrapperName = process.platform === "win32" ? "dart.bat" : "dart";
	return [
		process.env.DART_SDK
			? path.join(process.env.DART_SDK, "bin", executableName)
			: null,
		process.env.FLUTTER_ROOT
			? path.join(process.env.FLUTTER_ROOT, "bin", wrapperName)
			: null,
		process.env.FLUTTER_ROOT
			? path.join(
					process.env.FLUTTER_ROOT,
					"bin",
					"cache",
					"dart-sdk",
					"bin",
					executableName,
				)
			: null,
	].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveFlutterSdkCommands(): string[] {
	const flutterCommand =
		process.platform === "win32" ? "flutter.bat" : "flutter";
	const locateCommand = process.platform === "win32" ? "where" : "which";
	const locateResult = spawnSync(locateCommand, [flutterCommand], {
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (locateResult.status !== 0 || !locateResult.stdout) {
		return [];
	}

	const flutterExecutablePath = locateResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!flutterExecutablePath) {
		return [];
	}

	const flutterBinDir = path.dirname(flutterExecutablePath);
	const executableName = process.platform === "win32" ? "dart.exe" : "dart";
	const wrapperName = process.platform === "win32" ? "dart.bat" : "dart";

	return [
		path.join(flutterBinDir, wrapperName),
		path.join(flutterBinDir, "cache", "dart-sdk", "bin", executableName),
	];
}

function resolveDartCommand(): ResolvedDartCommand | null {
	const pathCommand = process.platform === "win32" ? "dart.bat" : "dart";
	const shell = process.platform === "win32";
	if (canExecute(pathCommand, shell)) {
		return {
			command: pathCommand,
			shell,
		};
	}

	for (const candidate of [
		...getEnvCandidateCommands(),
		...resolveFlutterSdkCommands(),
	]) {
		if (!canExecute(candidate, false)) {
			continue;
		}

		return {
			command: candidate,
			shell: false,
		};
	}

	return null;
}

function resolveTextDocumentSyncMode(result: unknown): "full" | "incremental" {
	const textDocumentSync = (
		result as {
			capabilities?: {
				textDocumentSync?:
					| number
					| {
							change?: number;
					  };
			};
		}
	)?.capabilities?.textDocumentSync;

	if (typeof textDocumentSync === "number") {
		return textDocumentSync === 2 ? "incremental" : "full";
	}

	if (
		textDocumentSync &&
		typeof textDocumentSync === "object" &&
		textDocumentSync.change === 2
	) {
		return "incremental";
	}

	return "full";
}

export class DartLanguageProvider implements LanguageServiceProvider {
	readonly id = "dart";

	readonly label = "Dart";

	readonly description =
		"Dart and Flutter diagnostics via the Dart language server.";

	readonly languageIds = ["dart"];

	private readonly sessions = new Map<string, WorkspaceSession>();

	private readonly workspaceErrors = new Map<string, string | null>();

	supportsLanguage(languageId: string): boolean {
		return languageId === "dart";
	}

	async openDocument(document: LanguageServiceDocument): Promise<void> {
		const session = await this.ensureSession(
			document.workspaceId,
			document.workspacePath,
		);
		const uri = absolutePathToFileUri(document.absolutePath);
		session.openDocuments.set(document.absolutePath, {
			languageId: document.languageId,
			version: document.version,
			content: document.content,
			uri,
		});
		await session.client.notify("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: "dart",
				version: document.version,
				text: document.content,
			},
		});
	}

	async changeDocument(document: LanguageServiceDocument): Promise<void> {
		const session = await this.ensureSession(
			document.workspaceId,
			document.workspacePath,
		);
		const previous = session.openDocuments.get(document.absolutePath);
		if (!previous) {
			await this.openDocument(document);
			return;
		}

		session.openDocuments.set(document.absolutePath, {
			languageId: document.languageId,
			version: document.version,
			content: document.content,
			uri: previous.uri,
		});

		await session.client.notify("textDocument/didChange", {
			textDocument: {
				uri: previous.uri,
				version: document.version,
			},
			contentChanges:
				session.textDocumentSyncMode === "incremental"
					? [
							{
								range: {
									start: { line: 0, character: 0 },
									end: offsetToLspPosition(
										previous.content,
										previous.content.length,
									),
								},
								text: document.content,
							},
						]
					: [
							{
								text: document.content,
							},
						],
		});
	}

	async closeDocument(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<void> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) {
			return;
		}

		const existing = session.openDocuments.get(args.absolutePath);
		session.openDocuments.delete(args.absolutePath);
		languageDiagnosticsStore.clearFileDiagnostics(
			args.workspaceId,
			this.fileKey(args.absolutePath),
		);

		if (existing) {
			await session.client.notify("textDocument/didClose", {
				textDocument: {
					uri: existing.uri,
				},
			});
		}

		if (session.openDocuments.size === 0) {
			await this.disposeWorkspace(args);
		}
	}

	async refreshWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) {
			return;
		}

		try {
			await session.client.request("dart/reanalyze");
			session.lastError = null;
		} catch (error) {
			session.lastError =
				error instanceof Error ? error.message : String(error);
			this.workspaceErrors.set(args.workspaceId, session.lastError);
		}
	}

	getWorkspaceSummary(args: {
		workspaceId: string;
		workspacePath: string;
		enabled: boolean;
	}): LanguageServiceProviderSummary {
		const session = this.sessions.get(args.workspaceId);
		const lastError =
			session?.lastError ?? this.workspaceErrors.get(args.workspaceId) ?? null;

		if (!args.enabled) {
			return {
				providerId: this.id,
				label: this.label,
				status: "disabled",
				details: null,
				documentCount: 0,
			};
		}

		if (!session) {
			return {
				providerId: this.id,
				label: this.label,
				status: lastError ? "error" : "idle",
				details: lastError,
				documentCount: 0,
			};
		}

		return {
			providerId: this.id,
			label: this.label,
			status: lastError ? "error" : "ready",
			details: lastError,
			documentCount: session.openDocuments.size,
		};
	}

	async disposeWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		const session = this.sessions.get(args.workspaceId);
		if (session) {
			await session.client.stop();
			this.sessions.delete(args.workspaceId);
		}

		this.workspaceErrors.delete(args.workspaceId);
	}

	private async ensureSession(
		workspaceId: string,
		workspacePath: string,
	): Promise<WorkspaceSession> {
		const existing = this.sessions.get(workspaceId);
		if (existing) {
			return existing;
		}

		const resolvedDartCommand = resolveDartCommand();
		if (!resolvedDartCommand) {
			const error =
				"dart command not found. Install Dart or Flutter, or set DART_SDK / FLUTTER_ROOT.";
			this.workspaceErrors.set(workspaceId, error);
			throw new Error(error);
		}

		let session!: WorkspaceSession;
		const client = new StdioJsonRpcClient({
			name: `dart:${workspaceId}`,
			command: resolvedDartCommand.command,
			args: [
				"language-server",
				"--client-id",
				"superset.desktop",
				"--client-version",
				"1.4.6",
			],
			cwd: workspacePath,
			env: process.env,
			shell: resolvedDartCommand.shell,
			onNotification: (message) => {
				this.handleNotification(session, message);
			},
			onRequest: async (message) => await this.handleServerRequest(message),
			onExit: ({ code, signal }) => {
				const error = `dart language-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`;
				session.lastError = error;
				this.workspaceErrors.set(workspaceId, error);
				this.sessions.delete(workspaceId);
			},
			onStderr: (chunk) => {
				console.error("[language-services/dart] stderr", {
					workspaceId,
					chunk,
				});
			},
		});

		session = {
			workspaceId,
			workspacePath,
			dartCommand: resolvedDartCommand.command,
			client,
			openDocuments: new Map(),
			lastError: null,
			textDocumentSyncMode: "full",
		};

		try {
			await client.start();
			const workspaceUri = absolutePathToFileUri(workspacePath);
			const initializeResult = await client.request("initialize", {
				processId: process.pid,
				clientInfo: {
					name: "Superset Desktop",
					version: "1.4.6",
				},
				rootUri: workspaceUri,
				rootPath: workspacePath,
				workspaceFolders: [
					{
						uri: workspaceUri,
						name: path.basename(workspacePath),
					},
				],
				capabilities: {
					workspace: {
						configuration: true,
						workspaceFolders: true,
					},
					textDocument: {
						publishDiagnostics: {
							relatedInformation: true,
						},
					},
				},
				initializationOptions: {
					onlyAnalyzeProjectsWithOpenFiles: true,
				},
			});
			await client.notify("initialized", {});
			session.textDocumentSyncMode =
				resolveTextDocumentSyncMode(initializeResult);
			session.lastError = null;
			this.workspaceErrors.delete(workspaceId);
			this.sessions.set(workspaceId, session);
			return session;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(workspaceId, message);
			await client.stop();
			throw error;
		}
	}

	private handleNotification(
		session: WorkspaceSession,
		message: {
			method: string;
			params?: unknown;
		},
	): void {
		if (message.method !== "textDocument/publishDiagnostics") {
			return;
		}

		const params = message.params as
			| {
					uri?: string;
					diagnostics?: DartDiagnostic[];
			  }
			| undefined;
		if (!params?.uri) {
			return;
		}

		const absolutePath = fileUriToAbsolutePath(params.uri);
		if (!absolutePath) {
			return;
		}

		languageDiagnosticsStore.setFileDiagnostics(
			session.workspaceId,
			this.fileKey(absolutePath),
			(params.diagnostics ?? []).map((diagnostic) =>
				this.mapDiagnostic(session.workspacePath, absolutePath, diagnostic),
			),
		);
	}

	private async handleServerRequest(message: {
		method: string;
		params?: unknown;
	}): Promise<unknown> {
		if (message.method !== "workspace/configuration") {
			return undefined;
		}

		const items = ((
			message.params as { items?: Array<{ section?: string | null }> | null }
		)?.items ?? []) as Array<{ section?: string | null }>;
		return items.map((item) => {
			if (item.section === "dart") {
				return {
					showTodos: false,
				};
			}

			return null;
		});
	}

	private mapDiagnostic(
		workspacePath: string,
		absolutePath: string,
		diagnostic: DartDiagnostic,
	): LanguageServiceDiagnostic {
		const relatedInformation = (
			diagnostic.relatedInformation ?? []
		).map<LanguageServiceRelatedInformation>((item) => {
			const relatedAbsolutePath =
				fileUriToAbsolutePath(item.location.uri) ?? absolutePath;
			return {
				absolutePath: relatedAbsolutePath,
				relativePath: toRelativeWorkspacePath(
					workspacePath,
					relatedAbsolutePath,
				),
				line: item.location.range.start.line + 1,
				column: item.location.range.start.character + 1,
				endLine: item.location.range.end.line + 1,
				endColumn: item.location.range.end.character + 1,
				message: item.message,
			};
		});

		return {
			providerId: this.id,
			source: diagnostic.source ?? "dart",
			absolutePath,
			relativePath: toRelativeWorkspacePath(workspacePath, absolutePath),
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			endLine: diagnostic.range.end.line + 1,
			endColumn: diagnostic.range.end.character + 1,
			message: diagnostic.message,
			code: diagnostic.code ?? null,
			severity: lspSeverityToLanguageServiceSeverity(diagnostic.severity),
			relatedInformation,
		};
	}

	private fileKey(absolutePath: string): string {
		return `${this.id}::${absolutePath}`;
	}
}
