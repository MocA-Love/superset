export type LanguageServiceSeverity = "error" | "warning" | "info" | "hint";

export interface LanguageServiceRelatedInformation {
	absolutePath: string | null;
	relativePath: string | null;
	line: number | null;
	column: number | null;
	endLine: number | null;
	endColumn: number | null;
	message: string;
}

export interface LanguageServiceDocument {
	workspaceId: string;
	workspacePath: string;
	absolutePath: string;
	languageId: string;
	content: string;
	version: number;
}

export interface LanguageServiceDiagnostic {
	providerId: string;
	source: string;
	absolutePath: string | null;
	relativePath: string | null;
	line: number | null;
	column: number | null;
	endLine: number | null;
	endColumn: number | null;
	message: string;
	code: string | number | null;
	severity: LanguageServiceSeverity;
	relatedInformation?: LanguageServiceRelatedInformation[];
}

export interface LanguageServiceProviderSummary {
	providerId: string;
	label: string;
	status: "ready" | "disabled" | "idle" | "error";
	details?: string | null;
	documentCount: number;
}

export interface LanguageServiceProviderDescriptor {
	providerId: string;
	label: string;
	description: string;
	languageIds: string[];
	enabled: boolean;
}

export interface LanguageServiceWorkspaceSnapshot {
	status: "ready";
	workspaceId: string;
	workspacePath: string;
	providers: LanguageServiceProviderSummary[];
	problems: LanguageServiceDiagnostic[];
	totalCount: number;
	truncated: boolean;
	summary: {
		errorCount: number;
		warningCount: number;
		infoCount: number;
		hintCount: number;
	};
}

export interface LanguageServiceProvider {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly languageIds: string[];
	supportsLanguage(languageId: string): boolean;
	openDocument(document: LanguageServiceDocument): Promise<void>;
	changeDocument(document: LanguageServiceDocument): Promise<void>;
	closeDocument(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<void>;
	refreshWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void>;
	getWorkspaceSummary(args: {
		workspaceId: string;
		workspacePath: string;
		enabled: boolean;
	}): LanguageServiceProviderSummary;
	disposeWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void>;
}
