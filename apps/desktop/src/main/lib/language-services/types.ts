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

/**
 * Location of a symbol reference returned by findReferences / call hierarchy.
 */
export interface LanguageServiceLocation {
	absolutePath: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

export interface LanguageServiceRange {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

export interface LanguageServiceMarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export interface LanguageServiceHover {
	contents: LanguageServiceMarkupContent[];
	range: LanguageServiceRange | null;
}

/**
 * A call hierarchy item returned by prepareCallHierarchy.
 */
export interface LanguageServiceCallHierarchyItem {
	name: string;
	kind: string;
	absolutePath: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	selectionLine: number;
	selectionColumn: number;
	selectionEndLine: number;
	selectionEndColumn: number;
}

/**
 * An incoming call hierarchy entry.
 */
export interface LanguageServiceIncomingCall {
	from: LanguageServiceCallHierarchyItem;
	fromRanges: Array<{
		line: number;
		column: number;
		endLine: number;
		endColumn: number;
	}>;
}

export interface LanguageServiceTextEdit {
	range: LanguageServiceRange;
	newText: string;
}

export type LanguageServiceFileOperation =
	| {
			kind: "create";
			absolutePath: string;
			overwrite?: boolean;
			ignoreIfExists?: boolean;
	  }
	| {
			kind: "rename";
			oldAbsolutePath: string;
			newAbsolutePath: string;
			overwrite?: boolean;
			ignoreIfExists?: boolean;
	  }
	| {
			kind: "delete";
			absolutePath: string;
			recursive?: boolean;
			ignoreIfNotExists?: boolean;
	  };

export interface LanguageServiceWorkspaceEdit {
	changes: Array<{
		absolutePath: string;
		edits: LanguageServiceTextEdit[];
	}>;
	fileOperations?: LanguageServiceFileOperation[];
}

export interface LanguageServiceCompletionItem {
	label: string;
	kind: number | null;
	detail: string | null;
	documentation: LanguageServiceMarkupContent | null;
	sortText: string | null;
	filterText: string | null;
	insertText: string;
	insertTextFormat: "plaintext" | "snippet";
	textEditRange: LanguageServiceRange | null;
	additionalTextEdits: LanguageServiceTextEdit[];
	commitCharacters: string[] | null;
	preselect: boolean;
	deprecated: boolean;
	tags: number[];
	command: {
		title: string;
		command: string;
		arguments?: unknown[];
	} | null;
	data: unknown;
}

export interface LanguageServiceCompletionList {
	isIncomplete: boolean;
	items: LanguageServiceCompletionItem[];
}

export interface LanguageServiceParameterInformation {
	label: string;
	documentation: LanguageServiceMarkupContent | null;
}

export interface LanguageServiceSignatureInformation {
	label: string;
	documentation: LanguageServiceMarkupContent | null;
	parameters: LanguageServiceParameterInformation[];
	activeParameter: number | null;
}

export interface LanguageServiceSignatureHelp {
	signatures: LanguageServiceSignatureInformation[];
	activeSignature: number;
	activeParameter: number;
}

export type LanguageServiceDocumentHighlightKind = "text" | "read" | "write";

export interface LanguageServiceDocumentHighlight {
	range: LanguageServiceRange;
	kind: LanguageServiceDocumentHighlightKind;
}

export interface LanguageServiceCodeAction {
	title: string;
	kind: string | null;
	isPreferred: boolean;
	disabledReason: string | null;
	edit: LanguageServiceWorkspaceEdit | null;
	command: {
		title: string;
		command: string;
		arguments?: unknown[];
	} | null;
	data: unknown;
}

export interface LanguageServicePrepareRenameResult {
	range: LanguageServiceRange | null;
	placeholder: string | null;
	/**
	 * True when the server returned `{ defaultBehavior: true }`, meaning
	 * rename is allowed at this position but the client should compute the
	 * range itself (typically using the word under the cursor).
	 */
	defaultBehavior: boolean;
}

export interface LanguageServiceInlayHint {
	line: number;
	column: number;
	label: string;
	kind: "type" | "parameter" | null;
	paddingLeft: boolean;
	paddingRight: boolean;
	tooltip: LanguageServiceMarkupContent | null;
}

export interface LanguageServiceSemanticTokens {
	resultId: string | null;
	data: number[];
}

export interface LanguageServiceSemanticTokensLegend {
	tokenTypes: string[];
	tokenModifiers: string[];
}

export interface LanguageServiceDocumentSymbol {
	name: string;
	detail: string | null;
	kind: number;
	tags: number[];
	range: LanguageServiceRange;
	selectionRange: LanguageServiceRange;
	children: LanguageServiceDocumentSymbol[];
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

	/**
	 * Find all references to a symbol at the given position.
	 * Returns null if the provider does not support this operation.
	 */
	findReferences?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null>;

	/**
	 * Get hover content for a symbol at the given position.
	 * Returns null if the provider does not support this operation.
	 */
	getHover?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceHover | null>;

	/**
	 * Get definitions for a symbol at the given position.
	 * Returns null if the provider does not support this operation.
	 */
	getDefinition?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null>;

	/**
	 * Prepare call hierarchy at the given position.
	 * Returns null if the provider does not support this operation.
	 */
	prepareCallHierarchy?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceCallHierarchyItem[] | null>;

	/**
	 * Get incoming calls for a call hierarchy item.
	 */
	getIncomingCalls?(args: {
		workspaceId: string;
		item: LanguageServiceCallHierarchyItem;
	}): Promise<LanguageServiceIncomingCall[] | null>;

	getTypeDefinition?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null>;

	getImplementation?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null>;

	getDocumentHighlights?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceDocumentHighlight[] | null>;

	getCompletion?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
	}): Promise<LanguageServiceCompletionList | null>;

	resolveCompletionItem?(args: {
		workspaceId: string;
		item: LanguageServiceCompletionItem;
	}): Promise<LanguageServiceCompletionItem | null>;

	getSignatureHelp?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
		isRetrigger?: boolean;
	}): Promise<LanguageServiceSignatureHelp | null>;

	getCodeActions?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
		only?: string[];
		diagnostics?: LanguageServiceDiagnostic[];
	}): Promise<LanguageServiceCodeAction[] | null>;

	resolveCodeAction?(args: {
		workspaceId: string;
		action: LanguageServiceCodeAction;
	}): Promise<LanguageServiceCodeAction | null>;

	prepareRename?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServicePrepareRenameResult | null>;

	rename?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		newName: string;
	}): Promise<LanguageServiceWorkspaceEdit | null>;

	getInlayHints?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	}): Promise<LanguageServiceInlayHint[] | null>;

	getSemanticTokens?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
	}): Promise<LanguageServiceSemanticTokens | null>;

	getSemanticTokensLegend?(args: {
		workspaceId: string;
	}): LanguageServiceSemanticTokensLegend | null;

	getDocumentSymbols?(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
	}): Promise<LanguageServiceDocumentSymbol[] | null>;

	/**
	 * Called by the manager after `applyWorkspaceEdit` writes a file to disk
	 * so the provider can re-sync any sessions that had the file open. The
	 * provider must NOT throw; it should resolve once all best-effort
	 * resyncs are dispatched.
	 */
	notifyDocumentChangedOnDisk?(args: {
		absolutePath: string;
		content: string;
	}): Promise<void>;

	/**
	 * Called by the manager after a file is renamed or deleted on disk so
	 * the provider can release any tracked state and notify the server.
	 */
	notifyFileResourceChange?(
		operation:
			| { kind: "rename"; oldAbsolutePath: string; newAbsolutePath: string }
			| { kind: "delete"; absolutePath: string }
			| { kind: "create"; absolutePath: string },
	): Promise<void>;
}
