import { useEffect, useMemo, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	getDocumentCurrentContent,
	hasInitializedDocumentBuffer,
} from "renderer/stores/editor-state/editorBufferRegistry";
import { useEditorDocumentsStore } from "renderer/stores/editor-state/useEditorDocumentsStore";

type TrackedDocument = {
	documentKey: string;
	workspaceId: string;
	absolutePath: string;
	languageId: string;
	content: string;
	version: number;
};

function resolveLanguageId(absolutePath: string): string | null {
	const normalizedPath = absolutePath.toLowerCase();
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
	return null;
}

export function LanguageServicesProvider() {
	const documentsByKey = useEditorDocumentsStore((state) => state.documents);
	const previousRef = useRef<Map<string, TrackedDocument>>(new Map());

	const trackedDocuments = useMemo(() => {
		const next = new Map<string, TrackedDocument>();

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
	}, [documentsByKey]);

	useEffect(() => {
		const previous = previousRef.current;

		console.log("[LanguageServicesProvider] tracked documents", {
			count: trackedDocuments.size,
			documents: Array.from(trackedDocuments.values()).map((document) => ({
				workspaceId: document.workspaceId,
				absolutePath: document.absolutePath,
				languageId: document.languageId,
				version: document.version,
				contentLength: document.content.length,
			})),
		});

		for (const [documentKey, tracked] of trackedDocuments.entries()) {
			const prev = previous.get(documentKey);
			if (!prev) {
				console.log("[LanguageServicesProvider] openDocument", {
					documentKey,
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
					version: tracked.version,
				});
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
				console.log("[LanguageServicesProvider] changeDocument", {
					documentKey,
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
					prevVersion: prev.version,
					nextVersion: tracked.version,
					contentLength: tracked.content.length,
				});
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

			console.log("[LanguageServicesProvider] closeDocument", {
				documentKey,
				workspaceId: tracked.workspaceId,
				absolutePath: tracked.absolutePath,
				languageId: tracked.languageId,
			});
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
				console.log("[LanguageServicesProvider] closeDocument on unmount", {
					workspaceId: tracked.workspaceId,
					absolutePath: tracked.absolutePath,
					languageId: tracked.languageId,
				});
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
