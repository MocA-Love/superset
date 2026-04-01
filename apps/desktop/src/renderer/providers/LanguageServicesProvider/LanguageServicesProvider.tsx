import { useEffect, useMemo, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	getDocumentCurrentContent,
	hasInitializedDocumentBuffer,
} from "renderer/stores/editor-state/editorBufferRegistry";
import { useEditorDocumentsStore } from "renderer/stores/editor-state/useEditorDocumentsStore";
import {
	type LanguageServiceProviderId,
	useLanguageServicePreferencesStore,
} from "renderer/stores/language-service-preferences";

type TrackedDocument = {
	documentKey: string;
	workspaceId: string;
	absolutePath: string;
	languageId: string;
	content: string;
	version: number;
};

function resolveLanguageId(absolutePath: string): string | null {
	const normalizedPath = absolutePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;
	if (normalizedPath.endsWith(".tsx")) {
		return "typescriptreact";
	}
	if (
		normalizedPath.endsWith(".ts") ||
		normalizedPath.endsWith(".mts") ||
		normalizedPath.endsWith(".cts")
	) {
		return "typescript";
	}
	if (normalizedPath.endsWith(".jsx")) {
		return "javascriptreact";
	}
	if (
		normalizedPath.endsWith(".js") ||
		normalizedPath.endsWith(".mjs") ||
		normalizedPath.endsWith(".cjs")
	) {
		return "javascript";
	}
	if (
		normalizedPath.endsWith(".jsonc") ||
		fileName === "jsconfig.json" ||
		fileName === "settings.json" ||
		fileName === "extensions.json" ||
		fileName === "launch.json" ||
		fileName === "tasks.json" ||
		fileName === "keybindings.json" ||
		/^tsconfig\..+\.json$/.test(fileName) ||
		fileName === "tsconfig.json"
	) {
		return "jsonc";
	}
	if (normalizedPath.endsWith(".json")) {
		return "json";
	}
	if (normalizedPath.endsWith(".toml")) {
		return "toml";
	}
	if (normalizedPath.endsWith(".dart")) {
		return "dart";
	}
	return null;
}

function resolveProviderId(
	languageId: string,
): LanguageServiceProviderId | null {
	switch (languageId) {
		case "typescript":
		case "typescriptreact":
		case "javascript":
		case "javascriptreact":
			return "typescript";
		case "json":
		case "jsonc":
			return "json";
		case "toml":
			return "toml";
		case "dart":
			return "dart";
		default:
			return null;
	}
}

export function LanguageServicesProvider() {
	const documentsByKey = useEditorDocumentsStore((state) => state.documents);
	const enabledProviders = useLanguageServicePreferencesStore(
		(state) => state.enabledProviders,
	);
	const hasHydratedPreferences = useLanguageServicePreferencesStore(
		(state) => state.hasHydrated,
	);
	const previousRef = useRef<Map<string, TrackedDocument>>(new Map());
	const hasAppliedInitialProviderPreferencesRef = useRef(false);
	const [isProviderPreferenceSyncReady, setIsProviderPreferenceSyncReady] =
		useState(false);

	useEffect(() => {
		if (
			!hasHydratedPreferences ||
			hasAppliedInitialProviderPreferencesRef.current
		) {
			return;
		}

		hasAppliedInitialProviderPreferencesRef.current = true;
		void Promise.allSettled(
			Object.entries(enabledProviders).map(([providerId, enabled]) =>
				electronTrpcClient.languageServices.setProviderEnabled.mutate({
					providerId,
					enabled,
				}),
			),
		).finally(() => {
			setIsProviderPreferenceSyncReady(true);
		});
	}, [enabledProviders, hasHydratedPreferences]);

	const trackedDocuments = useMemo(() => {
		const next = new Map<string, TrackedDocument>();
		if (!hasHydratedPreferences || !isProviderPreferenceSyncReady) {
			return next;
		}

		for (const document of Object.values(documentsByKey)) {
			if (
				document.sessionPaneIds.length === 0 ||
				document.status === "loading" ||
				!hasInitializedDocumentBuffer(document.documentKey)
			) {
				continue;
			}

			const languageId = resolveLanguageId(document.filePath);
			if (!languageId) {
				continue;
			}

			const providerId = resolveProviderId(languageId);
			if (providerId && !enabledProviders[providerId]) {
				continue;
			}

			next.set(document.documentKey, {
				documentKey: document.documentKey,
				workspaceId: document.workspaceId,
				absolutePath: document.filePath,
				languageId,
				content: getDocumentCurrentContent(document.documentKey),
				version: document.contentVersion,
			});
		}

		for (const [documentKey, tracked] of next.entries()) {
			if (tracked.version === 0 && tracked.content.length === 0) {
				next.delete(documentKey);
			}
		}

		return next;
	}, [
		documentsByKey,
		enabledProviders,
		hasHydratedPreferences,
		isProviderPreferenceSyncReady,
	]);

	useEffect(() => {
		const previous = previousRef.current;

		for (const [documentKey, tracked] of trackedDocuments.entries()) {
			const prev = previous.get(documentKey);
			if (!prev) {
				void electronTrpcClient.languageServices.openDocument.mutate({
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
					content: tracked.content,
					version: tracked.version,
				});
				continue;
			}

			if (
				prev.version !== tracked.version ||
				prev.absolutePath !== tracked.absolutePath ||
				prev.languageId !== tracked.languageId ||
				prev.workspaceId !== tracked.workspaceId
			) {
				void electronTrpcClient.languageServices.changeDocument.mutate({
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
					content: tracked.content,
					version: tracked.version,
				});
			}
		}

		for (const [documentKey, tracked] of previous.entries()) {
			if (trackedDocuments.has(documentKey)) {
				continue;
			}

			void electronTrpcClient.languageServices.closeDocument.mutate({
				workspaceId: tracked.workspaceId,
				absolutePath: tracked.absolutePath,
				languageId: tracked.languageId,
			});
		}

		previousRef.current = trackedDocuments;
	}, [trackedDocuments]);

	useEffect(() => {
		return () => {
			for (const tracked of previousRef.current.values()) {
				void electronTrpcClient.languageServices.closeDocument.mutate({
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
				});
			}
		};
	}, []);

	return null;
}
