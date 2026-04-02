import { languageDiagnosticsStore } from "../diagnostics-store";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
	LanguageServiceRelatedInformation,
} from "../types";
import {
	absolutePathToFileUri,
	fileUriToAbsolutePath,
	lspSeverityToLanguageServiceSeverity,
	offsetToLspPosition,
	toRelativeWorkspacePath,
} from "../utils";
import type { ResolvedLspCommand } from "./command-resolvers";
import { StdioJsonRpcClient } from "./StdioJsonRpcClient";

type OpenDocumentEntry = {
	languageId: string;
	version: number;
	content: string;
	uri: string;
};

type LspDiagnostic = {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number;
	code?: string | number | { value?: string | number };
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
	client: StdioJsonRpcClient;
	openDocuments: Map<string, OpenDocumentEntry>;
	lastError: string | null;
	textDocumentSyncMode: "full" | "incremental";
};

type ProviderArgs = {
	workspaceId: string;
	workspacePath: string;
};

type RefreshRequest = {
	method: string;
	params?: unknown | ((args: ProviderArgs) => unknown);
};

type ExternalLspProviderOptions = {
	id: string;
	label: string;
	description: string;
	languageIds: string[];
	resolveServerCommand:
		| ((args: ProviderArgs) => Promise<ResolvedLspCommand | null>)
		| ((args: ProviderArgs) => ResolvedLspCommand | null);
	mapDocumentLanguageId?: (languageId: string) => string;
	initializationOptions?: unknown | ((args: ProviderArgs) => unknown);
	configuration?: unknown | ((args: ProviderArgs) => unknown);
	refreshRequest?: RefreshRequest | null;
	clientCapabilities?: unknown;
	defaultSource?: string;
};

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

function getSectionValue(
	configuration: unknown,
	section?: string | null,
): unknown {
	if (!section) {
		return configuration ?? null;
	}

	const keys = section.split(".");
	let current: unknown = configuration;
	for (const key of keys) {
		if (!current || typeof current !== "object") {
			return null;
		}

		current = (current as Record<string, unknown>)[key];
		if (current === undefined) {
			return null;
		}
	}

	return current;
}

export class ExternalLspLanguageProvider implements LanguageServiceProvider {
	readonly id: string;

	readonly label: string;

	readonly description: string;

	readonly languageIds: string[];

	private readonly sessions = new Map<string, WorkspaceSession>();

	private readonly workspaceErrors = new Map<string, string | null>();

	constructor(private readonly options: ExternalLspProviderOptions) {
		this.id = options.id;
		this.label = options.label;
		this.description = options.description;
		this.languageIds = options.languageIds;
	}

	supportsLanguage(languageId: string): boolean {
		return this.languageIds.includes(languageId);
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
				languageId: this.mapDocumentLanguageId(document.languageId),
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

		await this.sendDidChange(
			session,
			previous,
			document.version,
			document.content,
		);
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
			const configuration = this.resolveConfiguration(args);
			if (configuration !== null) {
				await session.client.notify("workspace/didChangeConfiguration", {
					settings: configuration,
				});
			}

			if (this.options.refreshRequest) {
				const refreshParams =
					typeof this.options.refreshRequest.params === "function"
						? this.options.refreshRequest.params(args)
						: this.options.refreshRequest.params;
				await session.client.request(
					this.options.refreshRequest.method,
					refreshParams,
				);
			} else {
				for (const entry of session.openDocuments.values()) {
					await this.sendDidChange(
						session,
						entry,
						entry.version,
						entry.content,
					);
				}
			}
			session.lastError = null;
			this.workspaceErrors.delete(args.workspaceId);
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

		const resolvedCommand = await this.options.resolveServerCommand({
			workspaceId,
			workspacePath,
		});
		if (!resolvedCommand) {
			const message = `${this.label} language server is not available in this environment.`;
			this.workspaceErrors.set(workspaceId, message);
			throw new Error(message);
		}

		let session!: WorkspaceSession;
		const client = new StdioJsonRpcClient({
			name: `${this.id}:${workspaceId}`,
			command: resolvedCommand.command,
			args: resolvedCommand.args,
			cwd: resolvedCommand.cwd ?? workspacePath,
			env: resolvedCommand.env ?? process.env,
			shell: resolvedCommand.shell,
			onNotification: (message) => {
				this.handleNotification(session, message);
			},
			onRequest: async (message) =>
				await this.handleServerRequest(session, message),
			onExit: ({ code, signal }) => {
				const error = `${this.label} language server exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`;
				session.lastError = error;
				this.workspaceErrors.set(workspaceId, error);
				this.sessions.delete(workspaceId);
			},
			onStderr: (chunk) => {
				console.error(`[language-services/${this.id}] stderr`, {
					workspaceId,
					chunk,
				});
			},
		});

		session = {
			workspaceId,
			workspacePath,
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
						name: this.workspaceFolderName(workspacePath),
					},
				],
				capabilities: this.options.clientCapabilities ?? {
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
				initializationOptions: this.resolveInitializationOptions({
					workspaceId,
					workspacePath,
				}),
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

	private async sendDidChange(
		session: WorkspaceSession,
		previous: OpenDocumentEntry,
		version: number,
		content: string,
	): Promise<void> {
		await session.client.notify("textDocument/didChange", {
			textDocument: {
				uri: previous.uri,
				version,
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
								text: content,
							},
						]
					: [
							{
								text: content,
							},
						],
		});
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
					diagnostics?: LspDiagnostic[];
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

	private async handleServerRequest(
		session: WorkspaceSession,
		message: {
			method: string;
			params?: unknown;
		},
	): Promise<unknown> {
		switch (message.method) {
			case "workspace/configuration": {
				const items = ((
					message.params as {
						items?: Array<{ section?: string | null }> | null;
					}
				)?.items ?? []) as Array<{ section?: string | null }>;
				const configuration = this.resolveConfiguration({
					workspaceId: session.workspaceId,
					workspacePath: session.workspacePath,
				});
				return items.map((item) =>
					getSectionValue(configuration, item.section),
				);
			}
			case "workspace/workspaceFolders":
				return [
					{
						uri: absolutePathToFileUri(session.workspacePath),
						name: this.workspaceFolderName(session.workspacePath),
					},
				];
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
				return null;
			default:
				return undefined;
		}
	}

	private mapDiagnostic(
		workspacePath: string,
		absolutePath: string,
		diagnostic: LspDiagnostic,
	): LanguageServiceDiagnostic {
		const relatedInformation = (
			diagnostic.relatedInformation ?? []
		).map<LanguageServiceRelatedInformation>((item) => {
			const relatedAbsolutePath = fileUriToAbsolutePath(item.location.uri);
			return {
				absolutePath: relatedAbsolutePath,
				relativePath: relatedAbsolutePath
					? toRelativeWorkspacePath(workspacePath, relatedAbsolutePath)
					: null,
				line: item.location.range.start.line + 1,
				column: item.location.range.start.character + 1,
				endLine: item.location.range.end.line + 1,
				endColumn: item.location.range.end.character + 1,
				message: item.message,
			};
		});

		return {
			providerId: this.id,
			source: diagnostic.source ?? this.options.defaultSource ?? this.id,
			absolutePath,
			relativePath: toRelativeWorkspacePath(workspacePath, absolutePath),
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			endLine: diagnostic.range.end.line + 1,
			endColumn: diagnostic.range.end.character + 1,
			message: diagnostic.message,
			code:
				typeof diagnostic.code === "object"
					? (diagnostic.code?.value ?? null)
					: (diagnostic.code ?? null),
			severity: lspSeverityToLanguageServiceSeverity(diagnostic.severity),
			relatedInformation,
		};
	}

	private resolveInitializationOptions(args: ProviderArgs): unknown {
		return typeof this.options.initializationOptions === "function"
			? this.options.initializationOptions(args)
			: this.options.initializationOptions;
	}

	private resolveConfiguration(args: ProviderArgs): unknown {
		return typeof this.options.configuration === "function"
			? this.options.configuration(args)
			: (this.options.configuration ?? null);
	}

	private mapDocumentLanguageId(languageId: string): string {
		return this.options.mapDocumentLanguageId?.(languageId) ?? languageId;
	}

	private workspaceFolderName(workspacePath: string): string {
		return workspacePath.split(/[\\/]/).at(-1) || workspacePath;
	}

	private fileKey(absolutePath: string): string {
		return `${this.id}::${absolutePath}`;
	}
}
