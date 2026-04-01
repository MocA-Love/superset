import { languageDiagnosticsStore } from "./diagnostics-store";
import { TypeScriptLanguageProvider } from "./providers/typescript/TypeScriptLanguageProvider";
import type {
	LanguageServiceDocument,
	LanguageServiceProvider,
	LanguageServiceWorkspaceSnapshot,
} from "./types";

export class LanguageServiceManager {
	private readonly providers: LanguageServiceProvider[] = [
		new TypeScriptLanguageProvider(),
	];

	private readonly enabledProviders = new Map<string, boolean>([
		["typescript", true],
	]);

	async syncDocument(document: LanguageServiceDocument): Promise<void> {
		const provider = this.resolveProvider(document.languageId);
		if (!provider || !this.isProviderEnabled(provider.id)) {
			return;
		}

		await provider.changeDocument(document);
	}

	async openDocument(document: LanguageServiceDocument): Promise<void> {
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
		await Promise.all(
			this.providers.map((provider) => provider.disposeWorkspace(args)),
		);
		languageDiagnosticsStore.clearWorkspace(args.workspaceId);
	}

	getWorkspaceSnapshot(args: {
		workspaceId: string;
		workspacePath: string;
	}): LanguageServiceWorkspaceSnapshot {
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

	subscribeToWorkspace(
		workspaceId: string,
		listener: (payload: { version: number }) => void,
	) {
		return languageDiagnosticsStore.subscribe(workspaceId, listener);
	}

	private isProviderEnabled(providerId: string): boolean {
		return this.enabledProviders.get(providerId) ?? false;
	}

	private resolveProvider(languageId: string): LanguageServiceProvider | null {
		return (
			this.providers.find((provider) => provider.supportsLanguage(languageId)) ??
			null
		);
	}
}

export const languageServiceManager = new LanguageServiceManager();
