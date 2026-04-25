import { languageDiagnosticsStore } from "../diagnostics-store";
import type {
	LanguageServiceCallHierarchyItem,
	LanguageServiceCodeAction,
	LanguageServiceCompletionItem,
	LanguageServiceCompletionList,
	LanguageServiceDiagnostic,
	LanguageServiceDocument,
	LanguageServiceDocumentHighlight,
	LanguageServiceDocumentHighlightKind,
	LanguageServiceDocumentSymbol,
	LanguageServiceHover,
	LanguageServiceIncomingCall,
	LanguageServiceInlayHint,
	LanguageServiceLocation,
	LanguageServiceMarkupContent,
	LanguageServicePrepareRenameResult,
	LanguageServiceProvider,
	LanguageServiceProviderSummary,
	LanguageServiceRange,
	LanguageServiceRelatedInformation,
	LanguageServiceSemanticTokens,
	LanguageServiceSemanticTokensLegend,
	LanguageServiceSignatureHelp,
	LanguageServiceTextEdit,
	LanguageServiceWorkspaceEdit,
	LanguageServiceWorkspaceEditOperation,
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

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
};
type LspMarkupContent = {
	kind?: string;
	value?: string;
};
type LspMarkedString = string | { language?: string; value?: string };
type LspHover = {
	contents?: LspMarkupContent | LspMarkedString | LspMarkedString[];
	range?: LspRange;
};

type WorkspaceSession = {
	workspaceId: string;
	workspacePath: string;
	client: StdioJsonRpcClient;
	openDocuments: Map<string, OpenDocumentEntry>;
	lastError: string | null;
	textDocumentSyncMode: "full" | "incremental";
	semanticTokensLegend: LanguageServiceSemanticTokensLegend | null;
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
	/**
	 * Tap into custom server-sent notifications (publishClosingLabels,
	 * publishOutline, etc.). Called for every notification except those
	 * the base implementation already handles (publishDiagnostics).
	 */
	onCustomNotification?: (
		args: ProviderArgs,
		message: { method: string; params?: unknown },
	) => void;
};

type WorkspaceEditApplyOutcome = {
	applied: boolean;
	failures?: Array<{ absolutePath: string; reason: string }>;
};

let workspaceEditApplier:
	| ((edit: LanguageServiceWorkspaceEdit) => Promise<WorkspaceEditApplyOutcome>)
	| null = null;

export function setExternalLspWorkspaceEditApplier(
	applier: (
		edit: LanguageServiceWorkspaceEdit,
	) => Promise<WorkspaceEditApplyOutcome>,
): void {
	workspaceEditApplier = applier;
}

function resolveSemanticTokensLegend(
	result: unknown,
): LanguageServiceSemanticTokensLegend | null {
	const legend = (
		result as {
			capabilities?: {
				semanticTokensProvider?: {
					legend?: { tokenTypes?: string[]; tokenModifiers?: string[] };
				};
			};
		}
	)?.capabilities?.semanticTokensProvider?.legend;

	if (!legend?.tokenTypes || !legend?.tokenModifiers) {
		return null;
	}

	return {
		tokenTypes: legend.tokenTypes,
		tokenModifiers: legend.tokenModifiers,
	};
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

function lspRangeToLanguageServiceRange(
	range: LspRange | undefined,
): LanguageServiceRange | null {
	if (!range) {
		return null;
	}

	return {
		line: range.start.line + 1,
		column: range.start.character + 1,
		endLine: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function normalizeLspMarkupOrString(
	value: unknown,
): LanguageServiceMarkupContent | null {
	if (!value) {
		return null;
	}
	if (typeof value === "string") {
		return value ? { kind: "plaintext", value } : null;
	}
	const markup = value as LspMarkupContent;
	if (markup.value) {
		return {
			kind: markup.kind === "markdown" ? "markdown" : "plaintext",
			value: markup.value,
		};
	}
	return null;
}

function normalizeWorkspaceEdit(
	value: unknown,
): LanguageServiceWorkspaceEdit | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const edit = value as {
		changes?: Record<string, Array<{ range: LspRange; newText: string }>>;
		documentChanges?: Array<
			| {
					textDocument?: { uri: string; version?: number };
					edits?: Array<{ range: LspRange; newText: string }>;
			  }
			| {
					kind: "create";
					uri: string;
					options?: { overwrite?: boolean; ignoreIfExists?: boolean };
			  }
			| {
					kind: "rename";
					oldUri: string;
					newUri: string;
					options?: { overwrite?: boolean; ignoreIfExists?: boolean };
			  }
			| {
					kind: "delete";
					uri: string;
					options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
			  }
		>;
	};

	const operations: LanguageServiceWorkspaceEditOperation[] = [];

	// LSP allows either `documentChanges` (ordered, preferred) or the legacy
	// unordered `changes` map. When both are present, the spec says the
	// client SHOULD prefer `documentChanges`.
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (!change || typeof change !== "object") {
				continue;
			}

			if ("kind" in change) {
				if (change.kind === "create") {
					const absolutePath = fileUriToAbsolutePath(change.uri);
					if (absolutePath) {
						operations.push({
							kind: "create",
							absolutePath,
							overwrite: change.options?.overwrite,
							ignoreIfExists: change.options?.ignoreIfExists,
						});
					}
					continue;
				}
				if (change.kind === "rename") {
					const oldAbsolutePath = fileUriToAbsolutePath(change.oldUri);
					const newAbsolutePath = fileUriToAbsolutePath(change.newUri);
					if (oldAbsolutePath && newAbsolutePath) {
						operations.push({
							kind: "rename",
							oldAbsolutePath,
							newAbsolutePath,
							overwrite: change.options?.overwrite,
							ignoreIfExists: change.options?.ignoreIfExists,
						});
					}
					continue;
				}
				if (change.kind === "delete") {
					const absolutePath = fileUriToAbsolutePath(change.uri);
					if (absolutePath) {
						operations.push({
							kind: "delete",
							absolutePath,
							recursive: change.options?.recursive,
							ignoreIfNotExists: change.options?.ignoreIfNotExists,
						});
					}
					continue;
				}
				continue;
			}

			const textChange = change as {
				textDocument?: { uri: string };
				edits?: Array<{ range: LspRange; newText: string }>;
			};
			const uri = textChange.textDocument?.uri;
			if (!uri) continue;
			const absolutePath = fileUriToAbsolutePath(uri);
			if (!absolutePath) continue;
			const edits: LanguageServiceTextEdit[] = [];
			for (const e of textChange.edits ?? []) {
				const range = lspRangeToLanguageServiceRange(e.range);
				if (!range) continue;
				edits.push({ range, newText: e.newText });
			}
			if (edits.length > 0) {
				operations.push({ kind: "edits", absolutePath, edits });
			}
		}
	} else if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			const absolutePath = fileUriToAbsolutePath(uri);
			if (!absolutePath) continue;
			const collected: LanguageServiceTextEdit[] = [];
			for (const e of edits) {
				const range = lspRangeToLanguageServiceRange(e.range);
				if (!range) continue;
				collected.push({ range, newText: e.newText });
			}
			if (collected.length > 0) {
				operations.push({ kind: "edits", absolutePath, edits: collected });
			}
		}
	}

	if (operations.length === 0) {
		return null;
	}

	return { operations };
}

function denormalizeWorkspaceEdit(edit: LanguageServiceWorkspaceEdit): unknown {
	const documentChanges: unknown[] = [];

	for (const operation of edit.operations) {
		switch (operation.kind) {
			case "edits":
				documentChanges.push({
					textDocument: {
						uri: absolutePathToFileUri(operation.absolutePath),
						version: null,
					},
					edits: operation.edits.map((textEdit) => ({
						range: {
							start: {
								line: textEdit.range.line - 1,
								character: textEdit.range.column - 1,
							},
							end: {
								line: textEdit.range.endLine - 1,
								character: textEdit.range.endColumn - 1,
							},
						},
						newText: textEdit.newText,
					})),
				});
				break;
			case "create":
				documentChanges.push({
					kind: "create",
					uri: absolutePathToFileUri(operation.absolutePath),
					options:
						operation.overwrite !== undefined ||
						operation.ignoreIfExists !== undefined
							? {
									overwrite: operation.overwrite,
									ignoreIfExists: operation.ignoreIfExists,
								}
							: undefined,
				});
				break;
			case "rename":
				documentChanges.push({
					kind: "rename",
					oldUri: absolutePathToFileUri(operation.oldAbsolutePath),
					newUri: absolutePathToFileUri(operation.newAbsolutePath),
					options:
						operation.overwrite !== undefined ||
						operation.ignoreIfExists !== undefined
							? {
									overwrite: operation.overwrite,
									ignoreIfExists: operation.ignoreIfExists,
								}
							: undefined,
				});
				break;
			case "delete":
				documentChanges.push({
					kind: "delete",
					uri: absolutePathToFileUri(operation.absolutePath),
					options:
						operation.recursive !== undefined ||
						operation.ignoreIfNotExists !== undefined
							? {
									recursive: operation.recursive,
									ignoreIfNotExists: operation.ignoreIfNotExists,
								}
							: undefined,
				});
				break;
		}
	}

	return { documentChanges };
}

type RawCompletionItem = {
	label: string | { label: string; detail?: string; description?: string };
	kind?: number;
	detail?: string;
	documentation?: LspMarkupContent | string;
	deprecated?: boolean;
	preselect?: boolean;
	sortText?: string;
	filterText?: string;
	insertText?: string;
	insertTextFormat?: number;
	textEdit?: {
		range?: LspRange;
		insert?: LspRange;
		replace?: LspRange;
		newText: string;
	};
	additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
	commitCharacters?: string[];
	command?: {
		title: string;
		command: string;
		arguments?: unknown[];
	};
	tags?: number[];
	data?: unknown;
};

type RawSignatureHelp = {
	signatures?: Array<{
		label?: string;
		documentation?: LspMarkupContent | string;
		parameters?: Array<{
			label?: string | [number, number];
			documentation?: LspMarkupContent | string;
		}>;
		activeParameter?: number;
	}>;
	activeSignature?: number;
	activeParameter?: number;
};

type RawCodeAction = {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: unknown;
	/**
	 * `command` may be either a nested LSP `Command` literal (when this
	 * entry is a `CodeAction`) or a string identifier (when the server
	 * returned a top-level `Command` literal in the codeAction array).
	 */
	command?:
		| string
		| {
				title: string;
				command: string;
				arguments?: unknown[];
		  };
	arguments?: unknown[];
	data?: unknown;
};

type RawInlayHint = {
	position: { line: number; character: number };
	label: string | Array<{ value: string }>;
	kind?: number;
	paddingLeft?: boolean;
	paddingRight?: boolean;
	tooltip?: LspMarkupContent | string;
};

type RawDocumentSymbol = {
	name: string;
	detail?: string;
	kind: number;
	tags?: number[];
	range: LspRange;
	selectionRange: LspRange;
	children?: RawDocumentSymbol[];
};

function normalizeCompletionItem(
	item: RawCompletionItem,
): LanguageServiceCompletionItem {
	const label = typeof item.label === "string" ? item.label : item.label.label;
	const insertText = item.textEdit?.newText ?? item.insertText ?? label;
	const editRange =
		item.textEdit && "range" in item.textEdit && item.textEdit.range
			? item.textEdit.range
			: item.textEdit && "replace" in item.textEdit
				? item.textEdit.replace
				: undefined;

	return {
		label,
		kind: typeof item.kind === "number" ? item.kind : null,
		detail:
			typeof item.label === "object" && item.label.detail
				? item.label.detail
				: (item.detail ?? null),
		documentation: normalizeLspMarkupOrString(item.documentation),
		sortText: item.sortText ?? null,
		filterText: item.filterText ?? null,
		insertText,
		insertTextFormat: item.insertTextFormat === 2 ? "snippet" : "plaintext",
		textEditRange: editRange ? lspRangeToLanguageServiceRange(editRange) : null,
		additionalTextEdits: (item.additionalTextEdits ?? [])
			.map((edit) => {
				const range = lspRangeToLanguageServiceRange(edit.range);
				return range ? { range, newText: edit.newText } : null;
			})
			.filter((edit): edit is LanguageServiceTextEdit => edit !== null),
		commitCharacters: item.commitCharacters ?? null,
		preselect: Boolean(item.preselect),
		deprecated: Boolean(item.deprecated),
		tags: item.tags ?? [],
		command: item.command
			? {
					title: item.command.title,
					command: item.command.command,
					arguments: item.command.arguments,
				}
			: null,
		data: item.data ?? null,
	};
}

function denormalizeCompletionItem(
	item: LanguageServiceCompletionItem,
): unknown {
	return {
		label: item.label,
		kind: item.kind ?? undefined,
		detail: item.detail ?? undefined,
		documentation: item.documentation ?? undefined,
		sortText: item.sortText ?? undefined,
		filterText: item.filterText ?? undefined,
		insertText: item.insertText,
		insertTextFormat: item.insertTextFormat === "snippet" ? 2 : 1,
		commitCharacters: item.commitCharacters ?? undefined,
		preselect: item.preselect || undefined,
		deprecated: item.deprecated || undefined,
		tags: item.tags.length ? item.tags : undefined,
		command: item.command ?? undefined,
		data: item.data ?? undefined,
	};
}

function normalizeCodeAction(
	action: RawCodeAction,
): LanguageServiceCodeAction | null {
	if (!action || typeof action !== "object") {
		return null;
	}

	// LSP allows `textDocument/codeAction` results to include bare `Command`
	// literals (where `command` is a string id and any `arguments` live at
	// the top level) alongside `CodeAction` objects. Treat the bare-command
	// form as a command-only action so the server's command id is preserved.
	if (typeof action.command === "string") {
		return {
			title: action.title,
			kind: null,
			isPreferred: false,
			disabledReason: null,
			edit: null,
			command: {
				title: action.title,
				command: action.command,
				arguments: action.arguments,
			},
			data: action.data ?? null,
		};
	}

	return {
		title: action.title,
		kind: action.kind ?? null,
		isPreferred: Boolean(action.isPreferred),
		disabledReason: action.disabled?.reason ?? null,
		edit: normalizeWorkspaceEdit(action.edit),
		command: action.command
			? {
					title: action.command.title,
					command: action.command.command,
					arguments: action.command.arguments,
				}
			: null,
		data: action.data ?? null,
	};
}

function denormalizeCodeAction(action: LanguageServiceCodeAction): unknown {
	return {
		title: action.title,
		kind: action.kind ?? undefined,
		isPreferred: action.isPreferred || undefined,
		disabled: action.disabledReason
			? { reason: action.disabledReason }
			: undefined,
		edit: action.edit ? denormalizeWorkspaceEdit(action.edit) : undefined,
		command: action.command ?? undefined,
		data: action.data ?? undefined,
	};
}

function normalizeDocumentSymbol(
	symbol: RawDocumentSymbol,
): LanguageServiceDocumentSymbol | null {
	const range = lspRangeToLanguageServiceRange(symbol.range);
	const selectionRange = lspRangeToLanguageServiceRange(symbol.selectionRange);
	if (!range || !selectionRange) {
		return null;
	}

	return {
		name: symbol.name,
		detail: symbol.detail ?? null,
		kind: symbol.kind,
		tags: symbol.tags ?? [],
		range,
		selectionRange,
		children: (symbol.children ?? [])
			.map((child) => normalizeDocumentSymbol(child))
			.filter((c): c is LanguageServiceDocumentSymbol => c !== null),
	};
}

function diagnosticOverlapsRange(
	diagnostic: LanguageServiceDiagnostic,
	startLine: number,
	startColumn: number,
	endLine: number,
	endColumn: number,
): boolean {
	const dStartLine = diagnostic.line ?? 1;
	const dStartColumn = diagnostic.column ?? 1;
	const dEndLine = diagnostic.endLine ?? dStartLine;
	const dEndColumn = diagnostic.endColumn ?? dStartColumn;

	if (dEndLine < startLine) return false;
	if (dStartLine > endLine) return false;
	if (dEndLine === startLine && dEndColumn < startColumn) return false;
	if (dStartLine === endLine && dStartColumn > endColumn) return false;
	return true;
}

function lspDocumentHighlightKind(
	kind: number | undefined,
): LanguageServiceDocumentHighlightKind {
	switch (kind) {
		case 2:
			return "read";
		case 3:
			return "write";
		default:
			return "text";
	}
}

function lspLocationToLanguageServiceLocation(
	location: LspLocation | LspLocationLink,
): LanguageServiceLocation | null {
	const targetUri = "targetUri" in location ? location.targetUri : location.uri;
	const targetRange =
		"targetUri" in location
			? (location.targetSelectionRange ?? location.targetRange)
			: location.range;
	const absolutePath = fileUriToAbsolutePath(targetUri);
	if (!absolutePath) {
		return null;
	}

	return {
		absolutePath,
		line: targetRange.start.line + 1,
		column: targetRange.start.character + 1,
		endLine: targetRange.end.line + 1,
		endColumn: targetRange.end.character + 1,
	};
}

function normalizeMarkedString(
	value: LspMarkedString,
): LanguageServiceMarkupContent | null {
	if (typeof value === "string") {
		return value
			? {
					kind: "plaintext",
					value,
				}
			: null;
	}

	if (value.language && value.value) {
		return {
			kind: "markdown",
			value: `\`\`\`${value.language}\n${value.value}\n\`\`\``,
		};
	}

	if (value.value) {
		return {
			kind: "plaintext",
			value: value.value,
		};
	}

	return null;
}

function normalizeLspHoverContents(
	contents: LspHover["contents"],
): LanguageServiceMarkupContent[] {
	if (!contents) {
		return [];
	}

	if (Array.isArray(contents)) {
		return contents
			.map((item) => normalizeMarkedString(item))
			.filter((item): item is LanguageServiceMarkupContent => item !== null);
	}

	if (typeof contents === "string") {
		const normalized = normalizeMarkedString(contents);
		return normalized ? [normalized] : [];
	}

	if ("language" in contents) {
		const normalized = normalizeMarkedString(contents);
		return normalized ? [normalized] : [];
	}

	const markup = contents as LspMarkupContent;
	if (markup.value) {
		return [
			{
				kind: markup.kind === "markdown" ? "markdown" : "plaintext",
				value: markup.value,
			},
		];
	}

	return [];
}

export class ExternalLspLanguageProvider implements LanguageServiceProvider {
	readonly id: string;

	readonly label: string;

	readonly description: string;

	readonly languageIds: string[];

	private readonly sessions = new Map<string, WorkspaceSession>();

	private readonly pendingSessions = new Map<
		string,
		Promise<WorkspaceSession>
	>();

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

	async findReferences(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request("textDocument/references", {
				textDocument: {
					uri: absolutePathToFileUri(args.absolutePath),
				},
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
				context: { includeDeclaration: true },
			})) as Array<{
				uri: string;
				range: {
					start: { line: number; character: number };
					end: { line: number; character: number };
				};
			}> | null;

			if (!result) return null;

			return result
				.map((loc) => {
					const absPath = fileUriToAbsolutePath(loc.uri);
					if (!absPath) return null;
					return {
						absolutePath: absPath,
						line: loc.range.start.line + 1,
						column: loc.range.start.character + 1,
						endLine: loc.range.end.line + 1,
						endColumn: loc.range.end.character + 1,
					};
				})
				.filter((loc): loc is LanguageServiceLocation => loc !== null);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(args.workspaceId, message);
			return null;
		}
	}

	async getHover(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceHover | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request("textDocument/hover", {
				textDocument: {
					uri: absolutePathToFileUri(args.absolutePath),
				},
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
			})) as LspHover | null;

			const contents = normalizeLspHoverContents(result?.contents);
			if (contents.length === 0) {
				return null;
			}

			session.lastError = null;
			this.workspaceErrors.delete(args.workspaceId);
			return {
				contents,
				range: lspRangeToLanguageServiceRange(result?.range),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(args.workspaceId, message);
			return null;
		}
	}

	async getDefinition(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request("textDocument/definition", {
				textDocument: {
					uri: absolutePathToFileUri(args.absolutePath),
				},
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
			})) as
				| LspLocation
				| LspLocationLink
				| Array<LspLocation | LspLocationLink>
				| null;

			const locations = (
				Array.isArray(result) ? result : result ? [result] : []
			)
				.map((location) => lspLocationToLanguageServiceLocation(location))
				.filter(
					(location): location is LanguageServiceLocation => location !== null,
				);

			if (locations.length === 0) {
				return null;
			}

			session.lastError = null;
			this.workspaceErrors.delete(args.workspaceId);
			return locations;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(args.workspaceId, message);
			return null;
		}
	}

	async prepareCallHierarchy(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceCallHierarchyItem[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/prepareCallHierarchy",
				{
					textDocument: {
						uri: absolutePathToFileUri(args.absolutePath),
					},
					position: {
						line: args.line - 1,
						character: args.column - 1,
					},
				},
			)) as Array<{
				name: string;
				kind: number;
				uri: string;
				range: {
					start: { line: number; character: number };
					end: { line: number; character: number };
				};
				selectionRange: {
					start: { line: number; character: number };
					end: { line: number; character: number };
				};
			}> | null;

			if (!result) return null;

			return result
				.map((item) => {
					const absPath = fileUriToAbsolutePath(item.uri);
					if (!absPath) return null;
					return {
						name: item.name,
						kind: String(item.kind),
						absolutePath: absPath,
						line: item.range.start.line + 1,
						column: item.range.start.character + 1,
						endLine: item.range.end.line + 1,
						endColumn: item.range.end.character + 1,
						selectionLine: item.selectionRange.start.line + 1,
						selectionColumn: item.selectionRange.start.character + 1,
						selectionEndLine: item.selectionRange.end.line + 1,
						selectionEndColumn: item.selectionRange.end.character + 1,
					};
				})
				.filter(
					(item): item is LanguageServiceCallHierarchyItem => item !== null,
				);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(args.workspaceId, message);
			return null;
		}
	}

	async getIncomingCalls(args: {
		workspaceId: string;
		item: LanguageServiceCallHierarchyItem;
	}): Promise<LanguageServiceIncomingCall[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const lspItem = {
				name: args.item.name,
				kind: Number(args.item.kind),
				uri: absolutePathToFileUri(args.item.absolutePath),
				range: {
					start: {
						line: args.item.line - 1,
						character: args.item.column - 1,
					},
					end: {
						line: args.item.endLine - 1,
						character: args.item.endColumn - 1,
					},
				},
				selectionRange: {
					start: {
						line: args.item.selectionLine - 1,
						character: args.item.selectionColumn - 1,
					},
					end: {
						line: args.item.selectionEndLine - 1,
						character: args.item.selectionEndColumn - 1,
					},
				},
			};

			const result = (await session.client.request(
				"callHierarchy/incomingCalls",
				{ item: lspItem },
			)) as Array<{
				from: {
					name: string;
					kind: number;
					uri: string;
					range: {
						start: { line: number; character: number };
						end: { line: number; character: number };
					};
					selectionRange: {
						start: { line: number; character: number };
						end: { line: number; character: number };
					};
				};
				fromRanges: Array<{
					start: { line: number; character: number };
					end: { line: number; character: number };
				}>;
			}> | null;

			if (!result) return null;

			return result
				.map((call) => {
					const fromPath = fileUriToAbsolutePath(call.from.uri);
					if (!fromPath) return null;
					return {
						from: {
							name: call.from.name,
							kind: String(call.from.kind),
							absolutePath: fromPath,
							line: call.from.range.start.line + 1,
							column: call.from.range.start.character + 1,
							endLine: call.from.range.end.line + 1,
							endColumn: call.from.range.end.character + 1,
							selectionLine: call.from.selectionRange.start.line + 1,
							selectionColumn: call.from.selectionRange.start.character + 1,
							selectionEndLine: call.from.selectionRange.end.line + 1,
							selectionEndColumn: call.from.selectionRange.end.character + 1,
						},
						fromRanges: call.fromRanges.map((r) => ({
							line: r.start.line + 1,
							column: r.start.character + 1,
							endLine: r.end.line + 1,
							endColumn: r.end.character + 1,
						})),
					};
				})
				.filter((call): call is LanguageServiceIncomingCall => call !== null);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.lastError = message;
			this.workspaceErrors.set(args.workspaceId, message);
			return null;
		}
	}

	async getTypeDefinition(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		return await this.requestLocations(args, "textDocument/typeDefinition");
	}

	async getImplementation(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		return await this.requestLocations(args, "textDocument/implementation");
	}

	async getDocumentHighlights(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceDocumentHighlight[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/documentHighlight",
				{
					textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
					position: {
						line: args.line - 1,
						character: args.column - 1,
					},
				},
			)) as Array<{ range: LspRange; kind?: number }> | null;

			if (!result) return null;

			return result
				.map((highlight) => {
					const range = lspRangeToLanguageServiceRange(highlight.range);
					if (!range) return null;
					return {
						range,
						kind: lspDocumentHighlightKind(highlight.kind),
					};
				})
				.filter(
					(item): item is LanguageServiceDocumentHighlight => item !== null,
				);
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async getCompletion(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
	}): Promise<LanguageServiceCompletionList | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request("textDocument/completion", {
				textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
				context: {
					triggerKind: args.triggerKind ?? 1,
					...(args.triggerCharacter
						? { triggerCharacter: args.triggerCharacter }
						: {}),
				},
			})) as
				| Array<RawCompletionItem>
				| { isIncomplete?: boolean; items?: RawCompletionItem[] }
				| null;

			if (!result) return null;

			const isIncomplete = Array.isArray(result)
				? false
				: Boolean(result.isIncomplete);
			const items = Array.isArray(result) ? result : (result.items ?? []);

			return {
				isIncomplete,
				items: items.map((item) => normalizeCompletionItem(item)),
			};
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async resolveCompletionItem(args: {
		workspaceId: string;
		item: LanguageServiceCompletionItem;
	}): Promise<LanguageServiceCompletionItem | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const lspItem = denormalizeCompletionItem(args.item);
			const resolved = (await session.client.request(
				"completionItem/resolve",
				lspItem,
			)) as RawCompletionItem | null;
			if (!resolved) return args.item;
			return normalizeCompletionItem(resolved);
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return args.item;
		}
	}

	async getSignatureHelp(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
		isRetrigger?: boolean;
	}): Promise<LanguageServiceSignatureHelp | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/signatureHelp",
				{
					textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
					position: {
						line: args.line - 1,
						character: args.column - 1,
					},
					context: {
						triggerKind: args.triggerKind ?? 1,
						isRetrigger: Boolean(args.isRetrigger),
						...(args.triggerCharacter
							? { triggerCharacter: args.triggerCharacter }
							: {}),
					},
				},
			)) as RawSignatureHelp | null;

			if (!result || !Array.isArray(result.signatures)) {
				return null;
			}

			return {
				signatures: result.signatures.map((signature) => ({
					label: signature.label ?? "",
					documentation: normalizeLspMarkupOrString(signature.documentation),
					parameters: (signature.parameters ?? []).map((parameter) => ({
						label:
							typeof parameter.label === "string"
								? parameter.label
								: signature.label
									? signature.label.slice(
											parameter.label?.[0] ?? 0,
											parameter.label?.[1] ?? 0,
										)
									: "",
						documentation: normalizeLspMarkupOrString(parameter.documentation),
					})),
					activeParameter:
						typeof signature.activeParameter === "number"
							? signature.activeParameter
							: null,
				})),
				activeSignature:
					typeof result.activeSignature === "number"
						? result.activeSignature
						: 0,
				activeParameter:
					typeof result.activeParameter === "number"
						? result.activeParameter
						: 0,
			};
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async getCodeActions(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
		only?: string[];
		diagnostics?: LanguageServiceDiagnostic[];
	}): Promise<LanguageServiceCodeAction[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const lspDiagnostics = (args.diagnostics ?? [])
				.filter((diagnostic) =>
					diagnosticOverlapsRange(
						diagnostic,
						args.startLine,
						args.startColumn,
						args.endLine,
						args.endColumn,
					),
				)
				.map((diagnostic) => ({
					range: {
						start: {
							line: Math.max((diagnostic.line ?? 1) - 1, 0),
							character: Math.max((diagnostic.column ?? 1) - 1, 0),
						},
						end: {
							line: Math.max(
								(diagnostic.endLine ?? diagnostic.line ?? 1) - 1,
								0,
							),
							character: Math.max(
								(diagnostic.endColumn ?? diagnostic.column ?? 1) - 1,
								0,
							),
						},
					},
					severity:
						diagnostic.severity === "error"
							? 1
							: diagnostic.severity === "warning"
								? 2
								: diagnostic.severity === "info"
									? 3
									: 4,
					code: diagnostic.code ?? undefined,
					source: diagnostic.source,
					message: diagnostic.message,
				}));

			const result = (await session.client.request("textDocument/codeAction", {
				textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				range: {
					start: {
						line: args.startLine - 1,
						character: args.startColumn - 1,
					},
					end: { line: args.endLine - 1, character: args.endColumn - 1 },
				},
				context: {
					diagnostics: lspDiagnostics,
					...(args.only ? { only: args.only } : {}),
				},
			})) as Array<RawCodeAction> | null;

			if (!result) return null;

			return result
				.map((action) => normalizeCodeAction(action))
				.filter((item): item is LanguageServiceCodeAction => item !== null);
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async resolveCodeAction(args: {
		workspaceId: string;
		action: LanguageServiceCodeAction;
	}): Promise<LanguageServiceCodeAction | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const resolved = (await session.client.request(
				"codeAction/resolve",
				denormalizeCodeAction(args.action),
			)) as RawCodeAction | null;
			if (!resolved) return args.action;
			return normalizeCodeAction(resolved) ?? args.action;
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return args.action;
		}
	}

	async prepareRename(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
	}): Promise<LanguageServicePrepareRenameResult | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/prepareRename",
				{
					textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
					position: {
						line: args.line - 1,
						character: args.column - 1,
					},
				},
			)) as
				| LspRange
				| { range: LspRange; placeholder?: string }
				| { defaultBehavior: boolean }
				| null;

			if (!result) return null;
			if ("defaultBehavior" in result) {
				return result.defaultBehavior
					? { range: null, placeholder: null, defaultBehavior: true }
					: null;
			}

			if ("range" in result) {
				const range = lspRangeToLanguageServiceRange(result.range);
				if (!range) return null;
				return {
					range,
					placeholder: result.placeholder ?? null,
					defaultBehavior: false,
				};
			}

			const range = lspRangeToLanguageServiceRange(result);
			if (!range) return null;
			return { range, placeholder: null, defaultBehavior: false };
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async rename(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		line: number;
		column: number;
		newName: string;
	}): Promise<LanguageServiceWorkspaceEdit | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = await session.client.request("textDocument/rename", {
				textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
				newName: args.newName,
			});
			return normalizeWorkspaceEdit(result);
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async getInlayHints(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	}): Promise<LanguageServiceInlayHint[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request("textDocument/inlayHint", {
				textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				range: {
					start: {
						line: args.startLine - 1,
						character: args.startColumn - 1,
					},
					end: { line: args.endLine - 1, character: args.endColumn - 1 },
				},
			})) as Array<RawInlayHint> | null;

			if (!result) return null;

			return result.map((hint) => ({
				line: hint.position.line + 1,
				column: hint.position.character + 1,
				label:
					typeof hint.label === "string"
						? hint.label
						: hint.label.map((part) => part.value).join(""),
				kind: hint.kind === 1 ? "type" : hint.kind === 2 ? "parameter" : null,
				paddingLeft: Boolean(hint.paddingLeft),
				paddingRight: Boolean(hint.paddingRight),
				tooltip: normalizeLspMarkupOrString(hint.tooltip),
			}));
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async getSemanticTokens(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
	}): Promise<LanguageServiceSemanticTokens | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/semanticTokens/full",
				{
					textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				},
			)) as { resultId?: string; data?: number[] } | null;

			if (!result?.data) return null;
			return {
				resultId: result.resultId ?? null,
				data: result.data,
			};
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	getSemanticTokensLegend(args: {
		workspaceId: string;
	}): LanguageServiceSemanticTokensLegend | null {
		return this.sessions.get(args.workspaceId)?.semanticTokensLegend ?? null;
	}

	async getDocumentSymbols(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
	}): Promise<LanguageServiceDocumentSymbol[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(
				"textDocument/documentSymbol",
				{
					textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				},
			)) as Array<RawDocumentSymbol> | null;

			if (!result) return null;
			return result
				.map((symbol) => normalizeDocumentSymbol(symbol))
				.filter((s): s is LanguageServiceDocumentSymbol => s !== null);
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	async notifyDocumentChangedOnDisk(args: {
		absolutePath: string;
		content: string;
	}): Promise<void> {
		for (const session of this.sessions.values()) {
			const previous = session.openDocuments.get(args.absolutePath);
			if (!previous) {
				continue;
			}
			const nextVersion = previous.version + 1;
			session.openDocuments.set(args.absolutePath, {
				...previous,
				version: nextVersion,
				content: args.content,
			});
			try {
				await this.sendDidChange(session, previous, nextVersion, args.content);
			} catch (error) {
				this.recordError(session, session.workspaceId, error);
			}
		}
	}

	async notifyFileResourceChange(
		operation:
			| { kind: "rename"; oldAbsolutePath: string; newAbsolutePath: string }
			| { kind: "delete"; absolutePath: string }
			| { kind: "create"; absolutePath: string },
	): Promise<void> {
		const releaseDocument = async (
			session: WorkspaceSession,
			absolutePath: string,
		) => {
			const entry = session.openDocuments.get(absolutePath);
			if (!entry) return;
			try {
				await session.client.notify("textDocument/didClose", {
					textDocument: { uri: entry.uri },
				});
			} catch (error) {
				this.recordError(session, session.workspaceId, error);
			}
			session.openDocuments.delete(absolutePath);
			// Mirror closeDocument: also drop the cached diagnostics for the
			// stale path so renamed / deleted files do not linger in the
			// problems snapshot.
			languageDiagnosticsStore.clearFileDiagnostics(
				session.workspaceId,
				this.fileKey(absolutePath),
			);
		};

		if (operation.kind === "rename") {
			for (const session of this.sessions.values()) {
				await releaseDocument(session, operation.oldAbsolutePath);
			}
			return;
		}

		if (operation.kind === "delete") {
			for (const session of this.sessions.values()) {
				await releaseDocument(session, operation.absolutePath);
			}
		}
	}

	private async requestLocations(
		args: {
			workspaceId: string;
			absolutePath: string;
			line: number;
			column: number;
		},
		method: string,
	): Promise<LanguageServiceLocation[] | null> {
		const session = this.sessions.get(args.workspaceId);
		if (!session) return null;

		try {
			const result = (await session.client.request(method, {
				textDocument: { uri: absolutePathToFileUri(args.absolutePath) },
				position: {
					line: args.line - 1,
					character: args.column - 1,
				},
			})) as
				| LspLocation
				| LspLocationLink
				| Array<LspLocation | LspLocationLink>
				| null;

			const locations = (
				Array.isArray(result) ? result : result ? [result] : []
			)
				.map((location) => lspLocationToLanguageServiceLocation(location))
				.filter(
					(location): location is LanguageServiceLocation => location !== null,
				);

			if (locations.length === 0) {
				return null;
			}

			session.lastError = null;
			this.workspaceErrors.delete(args.workspaceId);
			return locations;
		} catch (error) {
			this.recordError(session, args.workspaceId, error);
			return null;
		}
	}

	private recordError(
		session: WorkspaceSession,
		workspaceId: string,
		error: unknown,
	): void {
		const message = error instanceof Error ? error.message : String(error);
		session.lastError = message;
		this.workspaceErrors.set(workspaceId, message);
	}

	private async ensureSession(
		workspaceId: string,
		workspacePath: string,
	): Promise<WorkspaceSession> {
		const existing = this.sessions.get(workspaceId);
		if (existing) {
			return existing;
		}

		const pending = this.pendingSessions.get(workspaceId);
		if (pending) {
			return pending;
		}

		const promise = this.initSession(workspaceId, workspacePath);
		this.pendingSessions.set(workspaceId, promise);
		try {
			return await promise;
		} finally {
			this.pendingSessions.delete(workspaceId);
		}
	}

	private async initSession(
		workspaceId: string,
		workspacePath: string,
	): Promise<WorkspaceSession> {
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
			semanticTokensLegend: null,
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
						applyEdit: true,
						workspaceEdit: {
							documentChanges: true,
							resourceOperations: ["create", "rename", "delete"],
							failureHandling: "abort",
						},
					},
					textDocument: {
						publishDiagnostics: {
							relatedInformation: true,
						},
						hover: {
							contentFormat: ["markdown", "plaintext"],
						},
						definition: {
							linkSupport: true,
						},
						typeDefinition: {
							linkSupport: true,
						},
						implementation: {
							linkSupport: true,
						},
						references: {
							dynamicRegistration: false,
						},
						documentHighlight: {
							dynamicRegistration: false,
						},
						callHierarchy: {
							dynamicRegistration: false,
						},
						documentSymbol: {
							dynamicRegistration: false,
							hierarchicalDocumentSymbolSupport: true,
						},
						completion: {
							completionItem: {
								snippetSupport: true,
								commitCharactersSupport: true,
								documentationFormat: ["markdown", "plaintext"],
								deprecatedSupport: true,
								preselectSupport: true,
								tagSupport: { valueSet: [1] },
								insertReplaceSupport: true,
								resolveSupport: {
									properties: [
										"documentation",
										"detail",
										"additionalTextEdits",
									],
								},
								insertTextModeSupport: { valueSet: [1, 2] },
								labelDetailsSupport: true,
							},
							completionItemKind: {
								valueSet: Array.from({ length: 25 }, (_, i) => i + 1),
							},
							contextSupport: true,
						},
						signatureHelp: {
							signatureInformation: {
								documentationFormat: ["markdown", "plaintext"],
								parameterInformation: { labelOffsetSupport: true },
								activeParameterSupport: true,
							},
							contextSupport: true,
						},
						codeAction: {
							codeActionLiteralSupport: {
								codeActionKind: {
									valueSet: [
										"",
										"quickfix",
										"refactor",
										"refactor.extract",
										"refactor.inline",
										"refactor.rewrite",
										"source",
										"source.organizeImports",
										"source.fixAll",
									],
								},
							},
							isPreferredSupport: true,
							dataSupport: true,
							resolveSupport: { properties: ["edit"] },
							disabledSupport: true,
						},
						rename: {
							prepareSupport: true,
							prepareSupportDefaultBehavior: 1,
						},
						inlayHint: {
							resolveSupport: {
								properties: ["tooltip", "label.tooltip"],
							},
						},
						semanticTokens: {
							dynamicRegistration: false,
							requests: { range: false, full: { delta: false } },
							tokenTypes: [
								"namespace",
								"type",
								"class",
								"enum",
								"interface",
								"struct",
								"typeParameter",
								"parameter",
								"variable",
								"property",
								"enumMember",
								"event",
								"function",
								"method",
								"macro",
								"keyword",
								"modifier",
								"comment",
								"string",
								"number",
								"regexp",
								"operator",
								"decorator",
							],
							tokenModifiers: [
								"declaration",
								"definition",
								"readonly",
								"static",
								"deprecated",
								"abstract",
								"async",
								"modification",
								"documentation",
								"defaultLibrary",
							],
							formats: ["relative"],
							overlappingTokenSupport: false,
							multilineTokenSupport: false,
							serverCancelSupport: false,
							augmentsSyntaxTokens: true,
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
			session.semanticTokensLegend =
				resolveSemanticTokensLegend(initializeResult);
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
			this.options.onCustomNotification?.(
				{
					workspaceId: session.workspaceId,
					workspacePath: session.workspacePath,
				},
				message,
			);
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
			case "workspace/applyEdit": {
				const params = message.params as
					| { label?: string; edit?: unknown }
					| undefined;
				const normalized = normalizeWorkspaceEdit(params?.edit);
				if (!normalized) {
					return { applied: false, failureReason: "no edit content" };
				}
				if (!workspaceEditApplier) {
					return {
						applied: false,
						failureReason: "no workspace edit applier registered",
					};
				}
				try {
					const result = await workspaceEditApplier(normalized);
					const firstFailure = result.failures?.[0];
					if (!result.applied && firstFailure) {
						const failedChange = normalized.operations.findIndex((op) => {
							const path =
								op.kind === "rename" ? op.newAbsolutePath : op.absolutePath;
							return path === firstFailure.absolutePath;
						});
						return {
							applied: result.applied,
							failureReason: `${firstFailure.absolutePath}: ${firstFailure.reason}`,
							...(failedChange >= 0 ? { failedChange } : {}),
						};
					}
					return { applied: result.applied };
				} catch (error) {
					return {
						applied: false,
						failureReason:
							error instanceof Error ? error.message : String(error),
					};
				}
			}
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
