import { languageDiagnosticsStore } from "./diagnostics-store";
import { DartLanguageProvider } from "./providers/dart/DartLanguageProvider";
import { JsonLanguageProvider } from "./providers/json/JsonLanguageProvider";
import { TomlLanguageProvider } from "./providers/toml/TomlLanguageProvider";
import { TypeScriptLanguageProvider } from "./providers/typescript/TypeScriptLanguageProvider";
import type {
	LanguageServiceProviderDescriptor,
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceWorkspaceSnapshot,
} from "./types";

export class LanguageServiceManager {
	private readonly providers: LanguageServiceProvider[] = [
		new TypeScriptLanguageProvider(),
		new JsonLanguageProvider(),
		new TomlLanguageProvider(),
		new DartLanguageProvider(),
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

	private isProviderEnabled(providerId: string): boolean {
		return this.enabledProviders.get(providerId) ?? false;
	}

	private rememberWorkspace(workspaceId: string, workspacePath: string): void {
		this.knownWorkspaces.set(workspaceId, workspacePath);
	}

	private resolveProvider(languageId: string): LanguageServiceProvider | null {
		return (
			this.providers.find((provider) => provider.supportsLanguage(languageId)) ??
			null
		);
	}
}

export const languageServiceManager = new LanguageServiceManager();
