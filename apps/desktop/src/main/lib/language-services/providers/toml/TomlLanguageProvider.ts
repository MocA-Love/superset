import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { Taplo } from "@taplo/lib";
import { languageDiagnosticsStore } from "../../diagnostics-store";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
} from "../../types";
import { offsetToLineColumn, toRelativeWorkspacePath } from "../../utils";

type OpenDocumentEntry = {
	languageId: string;
	version: number;
	content: string;
};

type WorkspaceState = {
	documents: Map<string, OpenDocumentEntry>;
	taploPromise: Promise<Taplo>;
	lastError: string | null;
};

const decoder = new TextDecoder();

function createTaploInstance(workspacePath: string): Promise<Taplo> {
	return Taplo.initialize({
		cwd: () => workspacePath,
		envVar: (key) => process.env[key] ?? "",
		envVars: () =>
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		findConfigFile: () => undefined,
		glob: () => [],
		isAbsolute: (candidate) => path.isAbsolute(candidate),
		now: () => new Date(),
		readFile: async (target) => await fs.readFile(target, "utf8"),
		writeFile: async () => {
			throw new Error("Taplo writeFile is not implemented");
		},
		stderr: async (chunk) => {
			console.error("[language-services/toml] taplo stderr", decoder.decode(chunk));
			return chunk.length;
		},
		stdErrAtty: () => false,
		stdin: async () => {
			throw new Error("Taplo stdin is not implemented");
		},
		stdout: async (chunk) => chunk.length,
		urlToFilePath: (uri) => fileURLToPath(uri),
	});
}

export class TomlLanguageProvider implements LanguageServiceProvider {
	readonly id = "toml";

	readonly label = "TOML";

	readonly description = "TOML diagnostics via Taplo.";

	readonly languageIds = ["toml"];

	private readonly workspaces = new Map<string, WorkspaceState>();

	supportsLanguage(languageId: string): boolean {
		return languageId === "toml";
	}

	async openDocument(document: LanguageServiceDocument): Promise<void> {
		const workspaceState = this.getOrCreateWorkspaceState(
			document.workspaceId,
			document.workspacePath,
		);
		workspaceState.documents.set(document.absolutePath, {
			languageId: document.languageId,
			version: document.version,
			content: document.content,
		});
		await this.validateDocument(document, workspaceState);
	}

	async changeDocument(document: LanguageServiceDocument): Promise<void> {
		const workspaceState = this.getOrCreateWorkspaceState(
			document.workspaceId,
			document.workspacePath,
		);
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

	private getOrCreateWorkspaceState(
		workspaceId: string,
		workspacePath: string,
	): WorkspaceState {
		const existing = this.workspaces.get(workspaceId);
		if (existing) {
			return existing;
		}

		const next: WorkspaceState = {
			documents: new Map(),
			taploPromise: createTaploInstance(workspacePath),
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
			const taplo = await workspaceState.taploPromise;
			const result = await taplo.lint(document.content);
			workspaceState.lastError = null;
			languageDiagnosticsStore.setFileDiagnostics(
				document.workspaceId,
				this.fileKey(document.absolutePath),
				result.errors.map((error) => this.mapDiagnostic(document, error)),
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
		document: LanguageServiceDocument,
		error: {
			range?: {
				start?: number;
				end?: number;
			};
			error: string;
		},
	): LanguageServiceDiagnostic {
		const start = offsetToLineColumn(document.content, error.range?.start ?? null);
		const end = offsetToLineColumn(document.content, error.range?.end ?? null);

		return {
			providerId: this.id,
			source: "toml",
			absolutePath: document.absolutePath,
			relativePath: toRelativeWorkspacePath(
				document.workspacePath,
				document.absolutePath,
			),
			line: start.line,
			column: start.column,
			endLine: end.line,
			endColumn: end.column,
			message: error.error,
			code: null,
			severity: "error",
			relatedInformation: [],
		};
	}

	private fileKey(absolutePath: string): string {
		return `${this.id}::${absolutePath}`;
	}
}
