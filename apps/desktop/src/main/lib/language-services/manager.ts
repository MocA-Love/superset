import * as fs from "node:fs/promises";
import { languageDiagnosticsStore } from "./diagnostics-store";
import { setExternalLspWorkspaceEditApplier } from "./lsp/ExternalLspLanguageProvider";
import type {
	LanguageServiceFileOperation,
	LanguageServiceTextEdit,
	LanguageServiceWorkspaceEditOperation,
} from "./types";

async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		await fs.access(absolutePath);
		return true;
	} catch {
		return false;
	}
}

function lineColumnToOffset(
	content: string,
	line: number,
	column: number,
): number {
	let currentLine = 1;
	let lineStartOffset = 0;
	for (let i = 0; i < content.length && currentLine < line; i += 1) {
		const ch = content[i];
		if (ch === "\n") {
			currentLine += 1;
			lineStartOffset = i + 1;
		} else if (ch === "\r") {
			currentLine += 1;
			if (content[i + 1] === "\n") i += 1;
			lineStartOffset = i + 1;
		}
	}
	if (currentLine !== line) {
		return content.length;
	}
	return Math.min(content.length, lineStartOffset + Math.max(0, column - 1));
}

function detectOverlap(
	sortedEdits: LanguageServiceTextEdit[],
	content: string,
): { aIndex: number; bIndex: number } | null {
	const offsets = sortedEdits.map((edit) => ({
		start: lineColumnToOffset(content, edit.range.line, edit.range.column),
		end: lineColumnToOffset(content, edit.range.endLine, edit.range.endColumn),
	}));
	for (let i = 0; i < offsets.length - 1; i += 1) {
		const current = offsets[i];
		const next = offsets[i + 1];
		if (next === undefined || current === undefined) continue;
		// sorted descending: next.end should be <= current.start
		if (next.end > current.start) {
			return { aIndex: i, bIndex: i + 1 };
		}
	}
	return null;
}

function applyTextEditsToContent(
	content: string,
	edits: LanguageServiceTextEdit[],
): { result: string; overlap: boolean } {
	const sorted = [...edits].sort((a, b) => {
		if (a.range.line !== b.range.line) return b.range.line - a.range.line;
		if (a.range.column !== b.range.column) {
			return b.range.column - a.range.column;
		}
		if (a.range.endLine !== b.range.endLine) {
			return b.range.endLine - a.range.endLine;
		}
		return b.range.endColumn - a.range.endColumn;
	});
	if (detectOverlap(sorted, content)) {
		return { result: content, overlap: true };
	}
	let result = content;
	for (const edit of sorted) {
		const start = lineColumnToOffset(
			result,
			edit.range.line,
			edit.range.column,
		);
		const end = lineColumnToOffset(
			result,
			edit.range.endLine,
			edit.range.endColumn,
		);
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return { result, overlap: false };
}

import { CssLanguageProvider } from "./providers/css/CssLanguageProvider";
import { DartLanguageProvider } from "./providers/dart/DartLanguageProvider";
import { DockerfileLanguageProvider } from "./providers/dockerfile/DockerfileLanguageProvider";
import { GoLanguageProvider } from "./providers/go/GoLanguageProvider";
import { GraphqlLanguageProvider } from "./providers/graphql/GraphqlLanguageProvider";
import { HtmlLanguageProvider } from "./providers/html/HtmlLanguageProvider";
import { JsonLanguageProvider } from "./providers/json/JsonLanguageProvider";
import { PythonLanguageProvider } from "./providers/python/PythonLanguageProvider";
import { RustLanguageProvider } from "./providers/rust/RustLanguageProvider";
import { TomlLanguageProvider } from "./providers/toml/TomlLanguageProvider";
import { TypeScriptLanguageProvider } from "./providers/typescript/TypeScriptLanguageProvider";
import { YamlLanguageProvider } from "./providers/yaml/YamlLanguageProvider";
import type {
	LanguageServiceCallHierarchyItem,
	LanguageServiceCodeAction,
	LanguageServiceCompletionItem,
	LanguageServiceCompletionList,
	LanguageServiceDocument,
	LanguageServiceDocumentHighlight,
	LanguageServiceDocumentSymbol,
	LanguageServiceHover,
	LanguageServiceIncomingCall,
	LanguageServiceInlayHint,
	LanguageServiceLocation,
	LanguageServicePrepareRenameResult,
	LanguageServiceProvider,
	LanguageServiceProviderDescriptor,
	LanguageServiceSemanticTokens,
	LanguageServiceSemanticTokensLegend,
	LanguageServiceSignatureHelp,
	LanguageServiceWorkspaceEdit,
	LanguageServiceWorkspaceSnapshot,
} from "./types";

export class LanguageServiceManager {
	private readonly providers: LanguageServiceProvider[] = [
		new TypeScriptLanguageProvider(),
		new JsonLanguageProvider(),
		new YamlLanguageProvider(),
		new HtmlLanguageProvider(),
		new CssLanguageProvider(),
		new TomlLanguageProvider(),
		new DartLanguageProvider(),
		new PythonLanguageProvider(),
		new GoLanguageProvider(),
		new RustLanguageProvider(),
		new DockerfileLanguageProvider(),
		new GraphqlLanguageProvider(),
	];

	private readonly enabledProviders = new Map<string, boolean>(
		this.providers.map((provider) => [provider.id, true] as const),
	);

	private readonly knownWorkspaces = new Map<string, string>();

	async syncDocument(document: LanguageServiceDocument): Promise<void> {
		this.rememberWorkspace(document.workspaceId, document.workspacePath);
		const provider = this.resolveProvider(document.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) {
			return;
		}

		await provider.changeDocument(document);
	}

	async openDocument(document: LanguageServiceDocument): Promise<void> {
		this.rememberWorkspace(document.workspaceId, document.workspacePath);
		const provider = this.resolveProvider(document.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) {
			return;
		}

		await provider.openDocument(document);
	}

	async closeDocument(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<void> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider) {
			return;
		}

		await provider.closeDocument(args);
	}

	async refreshWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		this.rememberWorkspace(args.workspaceId, args.workspacePath);
		await Promise.all(
			this.providers
				.filter((provider) => this.isProviderEnabled(provider.id))
				.map((provider) => provider.refreshWorkspace(args)),
		);
	}

	async disposeWorkspace(args: {
		workspaceId: string;
		workspacePath: string;
	}): Promise<void> {
		this.knownWorkspaces.delete(args.workspaceId);
		await Promise.all(
			this.providers.map((provider) => provider.disposeWorkspace(args)),
		);
		languageDiagnosticsStore.clearWorkspace(args.workspaceId);
	}

	getWorkspaceSnapshot(args: {
		workspaceId: string;
		workspacePath: string;
	}): LanguageServiceWorkspaceSnapshot {
		this.rememberWorkspace(args.workspaceId, args.workspacePath);
		return languageDiagnosticsStore.createSnapshot({
			workspaceId: args.workspaceId,
			workspacePath: args.workspacePath,
			providers: this.providers.map((provider) =>
				provider.getWorkspaceSummary({
					workspaceId: args.workspaceId,
					workspacePath: args.workspacePath,
					enabled: this.isProviderEnabled(provider.id),
				}),
			),
		});
	}

	getProviders(): LanguageServiceProviderDescriptor[] {
		return this.providers.map((provider) => ({
			providerId: provider.id,
			label: provider.label,
			description: provider.description,
			languageIds: provider.languageIds,
			enabled: this.isProviderEnabled(provider.id),
		}));
	}

	async setProviderEnabled(
		providerId: string,
		enabled: boolean,
	): Promise<LanguageServiceProviderDescriptor | null> {
		const provider = this.providers.find(
			(candidate) => candidate.id === providerId,
		);
		if (!provider) {
			return null;
		}

		const previous = this.isProviderEnabled(providerId);
		if (previous === enabled) {
			return {
				providerId: provider.id,
				label: provider.label,
				description: provider.description,
				languageIds: provider.languageIds,
				enabled,
			};
		}

		this.enabledProviders.set(providerId, enabled);

		if (!enabled) {
			await Promise.all(
				Array.from(this.knownWorkspaces.entries()).map(
					async ([workspaceId, workspacePath]) => {
						await provider.disposeWorkspace({
							workspaceId,
							workspacePath,
						});
					},
				),
			);
			languageDiagnosticsStore.clearProviderDiagnostics(providerId);
		}

		return {
			providerId: provider.id,
			label: provider.label,
			description: provider.description,
			languageIds: provider.languageIds,
			enabled,
		};
	}

	subscribeToWorkspace(
		workspaceId: string,
		listener: (payload: { version: number }) => void,
	) {
		return languageDiagnosticsStore.subscribe(workspaceId, listener);
	}

	async findReferences(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.findReferences?.(args)) ?? null;
	}

	async getHover(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceHover | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getHover?.(args)) ?? null;
	}

	async getDefinition(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getDefinition?.(args)) ?? null;
	}

	async prepareCallHierarchy(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceCallHierarchyItem[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.prepareCallHierarchy?.(args)) ?? null;
	}

	async getIncomingCalls(args: {
		workspaceId: string;
		languageId: string;
		item: LanguageServiceCallHierarchyItem;
	}): Promise<LanguageServiceIncomingCall[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (
			(await provider.getIncomingCalls?.({
				workspaceId: args.workspaceId,
				item: args.item,
			})) ?? null
		);
	}

	async getTypeDefinition(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getTypeDefinition?.(args)) ?? null;
	}

	async getImplementation(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceLocation[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getImplementation?.(args)) ?? null;
	}

	async getDocumentHighlights(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServiceDocumentHighlight[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getDocumentHighlights?.(args)) ?? null;
	}

	async getCompletion(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
	}): Promise<LanguageServiceCompletionList | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getCompletion?.(args)) ?? null;
	}

	async resolveCompletionItem(args: {
		workspaceId: string;
		languageId: string;
		item: LanguageServiceCompletionItem;
	}): Promise<LanguageServiceCompletionItem | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (
			(await provider.resolveCompletionItem?.({
				workspaceId: args.workspaceId,
				item: args.item,
			})) ?? null
		);
	}

	async getSignatureHelp(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
		triggerKind?: 1 | 2 | 3;
		triggerCharacter?: string;
		isRetrigger?: boolean;
	}): Promise<LanguageServiceSignatureHelp | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getSignatureHelp?.(args)) ?? null;
	}

	async getCodeActions(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
		only?: string[];
	}): Promise<LanguageServiceCodeAction[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		const diagnostics = languageDiagnosticsStore.getFileDiagnostics(
			args.workspaceId,
			args.absolutePath,
		);
		return (
			(await provider.getCodeActions?.({
				...args,
				diagnostics,
			})) ?? null
		);
	}

	async resolveCodeAction(args: {
		workspaceId: string;
		languageId: string;
		action: LanguageServiceCodeAction;
	}): Promise<LanguageServiceCodeAction | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (
			(await provider.resolveCodeAction?.({
				workspaceId: args.workspaceId,
				action: args.action,
			})) ?? null
		);
	}

	async prepareRename(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
	}): Promise<LanguageServicePrepareRenameResult | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.prepareRename?.(args)) ?? null;
	}

	async rename(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		line: number;
		column: number;
		newName: string;
	}): Promise<LanguageServiceWorkspaceEdit | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.rename?.(args)) ?? null;
	}

	async getInlayHints(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	}): Promise<LanguageServiceInlayHint[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getInlayHints?.(args)) ?? null;
	}

	async getSemanticTokens(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<LanguageServiceSemanticTokens | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getSemanticTokens?.(args)) ?? null;
	}

	getSemanticTokensLegend(args: {
		workspaceId: string;
		languageId: string;
	}): LanguageServiceSemanticTokensLegend | null {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (
			provider.getSemanticTokensLegend?.({
				workspaceId: args.workspaceId,
			}) ?? null
		);
	}

	async getDocumentSymbols(args: {
		workspaceId: string;
		workspacePath: string;
		absolutePath: string;
		languageId: string;
	}): Promise<LanguageServiceDocumentSymbol[] | null> {
		const provider = this.resolveProvider(args.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) return null;
		return (await provider.getDocumentSymbols?.(args)) ?? null;
	}

	async applyWorkspaceEdit(edit: LanguageServiceWorkspaceEdit): Promise<{
		applied: boolean;
		failures: Array<{ absolutePath: string; reason: string }>;
	}> {
		const failures: Array<{ absolutePath: string; reason: string }> = [];

		// Walk operations IN ORDER. LSP `documentChanges` semantics require
		// that a `create` or `rename` ahead of an `edits` op resolves before
		// the edit is applied — otherwise the edit may target the wrong file.
		for (const operation of edit.operations) {
			try {
				if (operation.kind === "edits") {
					await this.applyTextEditsOperation(operation);
				} else {
					await this.executeFileOperation(operation);
				}
			} catch (error) {
				failures.push({
					absolutePath: this.operationAbsolutePath(operation),
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return {
			applied: failures.length === 0,
			failures,
		};
	}

	private operationAbsolutePath(
		operation: LanguageServiceWorkspaceEditOperation,
	): string {
		switch (operation.kind) {
			case "rename":
				return operation.newAbsolutePath;
			default:
				return operation.absolutePath;
		}
	}

	private async applyTextEditsOperation(operation: {
		kind: "edits";
		absolutePath: string;
		edits: LanguageServiceTextEdit[];
	}): Promise<void> {
		const original = await fs.readFile(operation.absolutePath, "utf8");
		const { result, overlap } = applyTextEditsToContent(
			original,
			operation.edits,
		);
		if (overlap) {
			throw new Error("overlapping text edit ranges");
		}
		if (result !== original) {
			await fs.writeFile(operation.absolutePath, result, "utf8");
		}
		await Promise.all(
			this.providers.map((provider) =>
				provider
					.notifyDocumentChangedOnDisk?.({
						absolutePath: operation.absolutePath,
						content: result,
					})
					.catch(() => {
						/* best-effort */
					}),
			),
		);
	}

	private async executeFileOperation(
		operation: LanguageServiceFileOperation,
	): Promise<void> {
		if (operation.kind === "create") {
			const exists = await fileExists(operation.absolutePath);
			if (exists) {
				if (operation.ignoreIfExists && !operation.overwrite) {
					return;
				}
				if (!operation.overwrite) {
					throw new Error(`file already exists: ${operation.absolutePath}`);
				}
			}
			await fs.writeFile(operation.absolutePath, "", "utf8");
			await Promise.all(
				this.providers.map((provider) =>
					provider
						.notifyFileResourceChange?.({
							kind: "create",
							absolutePath: operation.absolutePath,
						})
						.catch(() => {
							/* best-effort */
						}),
				),
			);
			return;
		}

		if (operation.kind === "rename") {
			const destExists = await fileExists(operation.newAbsolutePath);
			if (destExists) {
				if (operation.ignoreIfExists && !operation.overwrite) {
					return;
				}
				if (!operation.overwrite) {
					throw new Error(
						`destination already exists: ${operation.newAbsolutePath}`,
					);
				}
			}
			await fs.rename(operation.oldAbsolutePath, operation.newAbsolutePath);
			await Promise.all(
				this.providers.map((provider) =>
					provider
						.notifyFileResourceChange?.({
							kind: "rename",
							oldAbsolutePath: operation.oldAbsolutePath,
							newAbsolutePath: operation.newAbsolutePath,
						})
						.catch(() => {
							/* best-effort */
						}),
				),
			);
			return;
		}

		// delete
		try {
			await fs.rm(operation.absolutePath, {
				recursive: operation.recursive ?? false,
				force: operation.ignoreIfNotExists ?? false,
			});
		} catch (error) {
			if (operation.ignoreIfNotExists) {
				return;
			}
			throw error;
		}
		await Promise.all(
			this.providers.map((provider) =>
				provider
					.notifyFileResourceChange?.({
						kind: "delete",
						absolutePath: operation.absolutePath,
					})
					.catch(() => {
						/* best-effort */
					}),
			),
		);
	}

	private isProviderEnabled(providerId: string): boolean {
		return this.enabledProviders.get(providerId) ?? false;
	}

	private rememberWorkspace(workspaceId: string, workspacePath: string): void {
		this.knownWorkspaces.set(workspaceId, workspacePath);
	}

	private resolveProvider(languageId: string): LanguageServiceProvider | null {
		return (
			this.providers.find((provider) =>
				provider.supportsLanguage(languageId),
			) ?? null
		);
	}
}

export const languageServiceManager = new LanguageServiceManager();

setExternalLspWorkspaceEditApplier(async (edit) => {
	const result = await languageServiceManager.applyWorkspaceEdit(edit);
	return { applied: result.applied };
});
