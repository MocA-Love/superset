import fs from "node:fs/promises";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService, type Diagnostic } from "vscode-json-languageservice";
import { languageDiagnosticsStore } from "../../diagnostics-store";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
} from "../../types";
import {
	absolutePathToFileUri,
	fileUriToAbsolutePath,
	lspSeverityToLanguageServiceSeverity,
	toRelativeWorkspacePath,
} from "../../utils";

type OpenDocumentEntry = {
	languageId: string;
	version: number;
	content: string;
};

type WorkspaceState = {
	documents: Map<string, OpenDocumentEntry>;
	lastError: string | null;
};

const KNOWN_JSON_SCHEMAS = [
	{
		uri: "https://json.schemastore.org/package.json",
		fileMatch: ["package.json"],
	},
	{
		uri: "https://json.schemastore.org/tsconfig.json",
		fileMatch: ["tsconfig.json", "tsconfig.*.json"],
	},
	{
		uri: "https://json.schemastore.org/jsconfig.json",
		fileMatch: ["jsconfig.json"],
	},
	{
		uri: "https://json.schemastore.org/bunfig.json",
		fileMatch: ["bunfig.json", "bunfig.*.json"],
	},
	{
		uri: "https://json.schemastore.org/turbo.json",
		fileMatch: ["turbo.json"],
	},
];

export class JsonLanguageProvider implements LanguageServiceProvider {
	readonly id = "json";

	readonly label = "JSON";

	readonly description = "JSON and JSONC diagnostics via vscode-json-languageservice.";

	readonly languageIds = ["json", "jsonc"];

	private readonly workspaces = new Map<string, WorkspaceState>();

	private readonly jsonService = getLanguageService({
		schemaRequestService: async (uri) => {
			if (uri.startsWith("file://")) {
				return await fs.readFile(new URL(uri), "utf8");
			}

			const response = await fetch(uri);
			if (!response.ok) {
				throw new Error(`Failed to load schema: ${uri} (${response.status})`);
			}

			return await response.text();
		},
	});

	constructor() {
		this.jsonService.configure({
			validate: true,
			allowComments: false,
			schemas: KNOWN_JSON_SCHEMAS,
		});
	}

	supportsLanguage(languageId: string): boolean {
		return languageId === "json" || languageId === "jsonc";
	}

	async openDocument(document: LanguageServiceDocument): Promise<void> {
		const workspaceState = this.getOrCreateWorkspaceState(document.workspaceId);
		workspaceState.documents.set(document.absolutePath, {
			languageId: document.languageId,
			version: document.version,
			content: document.content,
		});
		await this.validateDocument(document, workspaceState);
	}

	async changeDocument(document: LanguageServiceDocument): Promise<void> {
		const workspaceState = this.getOrCreateWorkspaceState(document.workspaceId);
		workspaceState.documents.set(document.absolutePath, {
			languageId: document.languageId,
			version: document.version,
			content: document.content,
		});
		await this.validateDocument(document, workspaceState);
	}

	async closeDocument(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<void> {
		const workspaceState = this.workspaces.get(args.workspaceId);
		if (!workspaceState) {
			return;
		}

		workspaceState.documents.delete(args.absolutePath);
		languageDiagnosticsStore.clearFileDiagnostics(
			args.workspaceId,
			this.fileKey(args.absolutePath),
		);

		if (workspaceState.documents.size === 0) {
			this.workspaces.delete(args.workspaceId);
		}
	}

	async refreshWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		const workspaceState = this.workspaces.get(args.workspaceId);
		if (!workspaceState) {
			return;
		}

		for (const [absolutePath, entry] of workspaceState.documents.entries()) {
			await this.validateDocument(
				{
					workspaceId: args.workspaceId,
					workspacePath: args.workspacePath,
					absolutePath,
					languageId: entry.languageId,
					content: entry.content,
					version: entry.version,
				},
				workspaceState,
			);
		}
	}

	getWorkspaceSummary(args: {
		workspaceId: string;
		workspacePath: string;
		enabled: boolean;
	}): LanguageServiceProviderSummary {
		const workspaceState = this.workspaces.get(args.workspaceId);
		if (!args.enabled) {
			return {
				providerId: this.id,
				label: this.label,
				status: "disabled",
				details: null,
				documentCount: 0,
			};
		}

		if (!workspaceState) {
			return {
				providerId: this.id,
				label: this.label,
				status: "idle",
				details: null,
				documentCount: 0,
			};
		}

		return {
			providerId: this.id,
			label: this.label,
			status: workspaceState.lastError ? "error" : "ready",
			details: workspaceState.lastError,
			documentCount: workspaceState.documents.size,
		};
	}

	async disposeWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		this.workspaces.delete(args.workspaceId);
	}

	private getOrCreateWorkspaceState(workspaceId: string): WorkspaceState {
		const existing = this.workspaces.get(workspaceId);
		if (existing) {
			return existing;
		}

		const next: WorkspaceState = {
			documents: new Map(),
			lastError: null,
		};
		this.workspaces.set(workspaceId, next);
		return next;
	}

	private async validateDocument(
		document: LanguageServiceDocument,
		workspaceState: WorkspaceState,
	): Promise<void> {
		try {
			const textDocument = TextDocument.create(
				absolutePathToFileUri(document.absolutePath),
				document.languageId,
				document.version,
				document.content,
			);
			const jsonDocument = this.jsonService.parseJSONDocument(textDocument);
			const diagnostics = await this.jsonService.doValidation(
				textDocument,
				jsonDocument,
				document.languageId === "jsonc"
					? {
							comments: "ignore",
							trailingCommas: "ignore",
							schemaRequest: "ignore",
					  }
					: {
							comments: "error",
							trailingCommas: "error",
							schemaRequest: "ignore",
					  },
			);
			workspaceState.lastError = null;
			languageDiagnosticsStore.setFileDiagnostics(
				document.workspaceId,
				this.fileKey(document.absolutePath),
				diagnostics.map((diagnostic) =>
					this.mapDiagnostic(document.workspacePath, document.absolutePath, diagnostic),
				),
			);
		} catch (error) {
			workspaceState.lastError =
				error instanceof Error ? error.message : String(error);
			languageDiagnosticsStore.setFileDiagnostics(
				document.workspaceId,
				this.fileKey(document.absolutePath),
				[],
			);
		}
	}

	private mapDiagnostic(
		workspacePath: string,
		absolutePath: string,
		diagnostic: Diagnostic,
	): LanguageServiceDiagnostic {
		return {
			providerId: this.id,
			source: diagnostic.source ?? "json",
			absolutePath,
			relativePath: toRelativeWorkspacePath(workspacePath, absolutePath),
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			endLine: diagnostic.range.end.line + 1,
			endColumn: diagnostic.range.end.character + 1,
			message: diagnostic.message,
			code: diagnostic.code ?? null,
			severity: lspSeverityToLanguageServiceSeverity(diagnostic.severity),
			relatedInformation:
				diagnostic.relatedInformation?.map((item) => {
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
				}) ?? [],
		};
	}

	private fileKey(absolutePath: string): string {
		return `${this.id}::${absolutePath}`;
	}
}
