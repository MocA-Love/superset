import { useEffect, useMemo, useRef, useState } from "react";
import {
	resolveLanguageServiceLanguageId,
	resolveLanguageServiceProviderId,
} from "renderer/lib/language-services";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	getDocumentCurrentContent,
	hasInitializedDocumentBuffer,
} from "renderer/stores/editor-state/editorBufferRegistry";
import { useEditorDocumentsStore } from "renderer/stores/editor-state/useEditorDocumentsStore";
import { useLanguageServicePreferencesStore } from "renderer/stores/language-service-preferences";

type TrackedDocument = {
	documentKey: string;
	workspaceId: string;
	absolutePath: string;
	languageId: string;
	content: string;
	version: number;
};

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

			const languageId = resolveLanguageServiceLanguageId(document.filePath);
			if (!languageId) {
				continue;
			}

			const providerId = resolveLanguageServiceProviderId(languageId);
			if (providerId && enabledProviders[providerId] === false) {
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
