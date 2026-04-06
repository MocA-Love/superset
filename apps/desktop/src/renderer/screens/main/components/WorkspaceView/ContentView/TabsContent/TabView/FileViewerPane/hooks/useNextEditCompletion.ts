import { chatServiceTrpc } from "@superset/chat/client";
import { useCallback } from "react";

interface UseNextEditCompletionOptions {
	filePath: string;
}

export function useNextEditCompletion({
	filePath,
}: UseNextEditCompletionOptions) {
	const { data: nextEditConfig } = chatServiceTrpc.nextEdit.getConfig.useQuery();
	const { data: inceptionStatus } = chatServiceTrpc.auth.getInceptionStatus.useQuery();
	const completeMutation = chatServiceTrpc.nextEdit.complete.useMutation();

	const isAvailable =
		nextEditConfig?.enabled === true && inceptionStatus?.authenticated === true;

	const requestInlineCompletion = useCallback(
		async ({
			currentFileContent,
			cursorOffset,
		}: {
			currentFileContent: string;
			cursorOffset: number;
		}) => {
			if (!isAvailable) {
				return null;
			}

			try {
				const result = await completeMutation.mutateAsync({
					filePath,
					currentFileContent,
					cursorOffset,
				});
				return result.insertText;
			} catch (error) {
				console.warn("[FileViewerPane] Next Edit request failed:", error);
				return null;
			}
		},
		[completeMutation, filePath, isAvailable],
	);

	return {
		isAvailable,
		requestInlineCompletion,
	};
}
