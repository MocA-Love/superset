import {
	type Diagnostic,
	getCSSLanguageService,
	getLESSLanguageService,
	getSCSSLanguageService,
} from "vscode-css-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import { languageDiagnosticsStore } from "../../diagnostics-store";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
} from "../../types";
import {
	absolutePathToFileUri,
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

export class CssLanguageProvider implements LanguageServiceProvider {
	readonly id = "css";

	readonly label = "CSS";

	readonly description =
		"CSS, SCSS and LESS diagnostics via vscode-css-languageservice.";

	readonly languageIds = ["css", "scss", "less"];

	private readonly workspaces = new Map<string, WorkspaceState>();

	private readonly cssService = getCSSLanguageService();

	private readonly scssService = getSCSSLanguageService();

	private readonly lessService = getLESSLanguageService();

	supportsLanguage(languageId: string): boolean {
		return this.languageIds.includes(languageId);
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
			const languageService = this.getLanguageService(document.languageId);
			const stylesheet = languageService.parseStylesheet(textDocument);
			const diagnostics = languageService.doValidation(
				textDocument,
				stylesheet,
			);
			workspaceState.lastError = null;
			languageDiagnosticsStore.setFileDiagnostics(
				document.workspaceId,
				this.fileKey(document.absolutePath),
				diagnostics.map((diagnostic) =>
					this.mapDiagnostic(
						document.workspacePath,
						document.absolutePath,
						diagnostic,
					),
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

	private getLanguageService(languageId: string) {
		switch (languageId) {
			case "scss":
				return this.scssService;
			case "less":
				return this.lessService;
			default:
				return this.cssService;
		}
	}

	private mapDiagnostic(
		workspacePath: string,
		absolutePath: string,
		diagnostic: Diagnostic,
	): LanguageServiceDiagnostic {
		return {
			providerId: this.id,
			source: diagnostic.source ?? "css",
			absolutePath,
			relativePath: toRelativeWorkspacePath(workspacePath, absolutePath),
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			endLine: diagnostic.range.end.line + 1,
			endColumn: diagnostic.range.end.character + 1,
			message: diagnostic.message,
			code: diagnostic.code ?? null,
			severity: lspSeverityToLanguageServiceSeverity(diagnostic.severity),
			relatedInformation: [],
		};
	}

	private fileKey(absolutePath: string): string {
		return `${this.id}::${absolutePath}`;
	}
}
