import { chatServiceTrpc } from "@superset/chat/client";
import { useCallback, useEffect, useRef } from "react";

interface UseNextEditCompletionOptions {
	filePath: string;
}

interface RecentSnippet {
	filePath: string;
	content: string;
	key: string;
}

const RECENT_SNIPPET_LIMIT = 5;
const EDIT_HISTORY_LIMIT = 5;
const SNIPPET_CONTEXT_BEFORE_LINES = 10;
const SNIPPET_CONTEXT_AFTER_LINES = 9;
const EDIT_HISTORY_FLUSH_DELAY_MS = 900;

function logNextEditDebug(
	message: string,
	details?: Record<string, unknown>,
): void {
	if (details) {
		console.log(`[NextEdit] ${message}`, details);
		return;
	}

	console.log(`[NextEdit] ${message}`);
}

function getLineStartOffsets(content: string): number[] {
	const offsets = [0];
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] === "\n") {
			offsets.push(index + 1);
		}
	}
	return offsets;
}

function getLineNumberAtOffset(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (lineStarts[mid] <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return high + 1;
}

function extractSnippetAtCursor(args: {
	filePath: string;
	content: string;
	cursorOffset: number;
}): RecentSnippet | null {
	if (!args.content.trim()) {
		return null;
	}

	const clampedOffset = Math.max(
		0,
		Math.min(args.content.length, Math.trunc(args.cursorOffset)),
	);
	const lineStarts = getLineStartOffsets(args.content);
	const currentLine = getLineNumberAtOffset(lineStarts, clampedOffset);
	const startLine = Math.max(1, currentLine - SNIPPET_CONTEXT_BEFORE_LINES);
	const endLine = Math.min(
		lineStarts.length,
		currentLine + SNIPPET_CONTEXT_AFTER_LINES,
	);
	const startOffset = lineStarts[startLine - 1] ?? 0;
	const endOffset =
		endLine < lineStarts.length ? lineStarts[endLine] : args.content.length;
	const content = args.content.slice(startOffset, endOffset).trimEnd();

	if (!content) {
		return null;
	}

	return {
		filePath: args.filePath,
		content,
		key: `${args.filePath}:${startLine}-${endLine}`,
	};
}

function buildUnifiedDiff(args: {
	filePath: string;
	before: string;
	after: string;
}): string | null {
	if (args.before === args.after) {
		return null;
	}

	const beforeLines = args.before.split("\n");
	const afterLines = args.after.split("\n");
	let prefixLength = 0;
	while (
		prefixLength < beforeLines.length &&
		prefixLength < afterLines.length &&
		beforeLines[prefixLength] === afterLines[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < beforeLines.length - prefixLength &&
		suffixLength < afterLines.length - prefixLength &&
		beforeLines[beforeLines.length - 1 - suffixLength] ===
			afterLines[afterLines.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	const removedLines = beforeLines.slice(
		prefixLength,
		beforeLines.length - suffixLength,
	);
	const addedLines = afterLines.slice(
		prefixLength,
		afterLines.length - suffixLength,
	);

	if (removedLines.length === 0 && addedLines.length === 0) {
		return null;
	}

	return [
		`--- ${args.filePath}`,
		`+++ ${args.filePath}`,
		`@@ -${prefixLength + 1},${removedLines.length} +${prefixLength + 1},${addedLines.length} @@`,
		...removedLines.map((line) => `-${line}`),
		...addedLines.map((line) => `+${line}`),
	].join("\n");
}

export function useNextEditCompletion({
	filePath,
}: UseNextEditCompletionOptions) {
	const { data: nextEditConfig } =
		chatServiceTrpc.nextEdit.getConfig.useQuery();
	const { data: inceptionStatus } =
		chatServiceTrpc.auth.getInceptionStatus.useQuery();
	const completeMutation = chatServiceTrpc.nextEdit.complete.useMutation();
	const recentSnippetsRef = useRef<RecentSnippet[]>([]);
	const editHistoryRef = useRef<string[]>([]);
	const committedContentRef = useRef("");
	const pendingContentRef = useRef<string | null>(null);
	const pendingFlushTimerRef = useRef<number | null>(null);
	const activeFilePathRef = useRef(filePath);

	const isAvailable =
		nextEditConfig?.enabled === true && inceptionStatus?.authenticated === true;

	useEffect(() => {
		activeFilePathRef.current = filePath;
	}, [filePath]);

	useEffect(() => {
		logNextEditDebug("state updated", {
			filePath,
			enabled: nextEditConfig?.enabled ?? false,
			authenticated: inceptionStatus?.authenticated ?? false,
			isAvailable,
			model: nextEditConfig?.model ?? null,
		});
	}, [
		filePath,
		inceptionStatus?.authenticated,
		isAvailable,
		nextEditConfig?.enabled,
		nextEditConfig?.model,
	]);

	const commitEditHistoryEntry = useCallback((nextContent: string) => {
		const previousContent = committedContentRef.current;
		if (previousContent === nextContent) {
			pendingContentRef.current = null;
			return;
		}

		const diff = buildUnifiedDiff({
			filePath: activeFilePathRef.current,
			before: previousContent,
			after: nextContent,
		});
		committedContentRef.current = nextContent;
		pendingContentRef.current = null;

		if (!diff) {
			return;
		}

		editHistoryRef.current = [...editHistoryRef.current, diff].slice(
			-EDIT_HISTORY_LIMIT,
		);
		logNextEditDebug("edit history updated", {
			filePath: activeFilePathRef.current,
			editHistoryCount: editHistoryRef.current.length,
		});
	}, []);

	const flushPendingEditHistory = useCallback(() => {
		if (pendingFlushTimerRef.current !== null) {
			window.clearTimeout(pendingFlushTimerRef.current);
			pendingFlushTimerRef.current = null;
		}

		if (pendingContentRef.current === null) {
			return;
		}

		commitEditHistoryEntry(pendingContentRef.current);
	}, [commitEditHistoryEntry]);

	const syncDocumentSnapshot = useCallback(
		(content: string) => {
			activeFilePathRef.current = filePath;
			committedContentRef.current = content;
			pendingContentRef.current = null;
			if (pendingFlushTimerRef.current !== null) {
				window.clearTimeout(pendingFlushTimerRef.current);
				pendingFlushTimerRef.current = null;
			}
			logNextEditDebug("document snapshot synced", {
				filePath,
				contentLength: content.length,
			});
		},
		[filePath],
	);

	const trackDocumentChange = useCallback(
		(content: string) => {
			pendingContentRef.current = content;
			if (pendingFlushTimerRef.current !== null) {
				window.clearTimeout(pendingFlushTimerRef.current);
			}
			pendingFlushTimerRef.current = window.setTimeout(() => {
				pendingFlushTimerRef.current = null;
				if (pendingContentRef.current !== null) {
					commitEditHistoryEntry(pendingContentRef.current);
				}
			}, EDIT_HISTORY_FLUSH_DELAY_MS);
		},
		[commitEditHistoryEntry],
	);

	useEffect(
		() => () => {
			if (pendingFlushTimerRef.current !== null) {
				window.clearTimeout(pendingFlushTimerRef.current);
			}
		},
		[],
	);

	const requestInlineCompletion = useCallback(
		async ({
			currentFileContent,
			cursorOffset,
		}: {
			currentFileContent: string;
			cursorOffset: number;
		}) => {
			if (!isAvailable) {
				logNextEditDebug("request skipped: unavailable", {
					filePath,
					enabled: nextEditConfig?.enabled ?? false,
					authenticated: inceptionStatus?.authenticated ?? false,
				});
				return null;
			}

			try {
				flushPendingEditHistory();
				const nextSnippet = extractSnippetAtCursor({
					filePath,
					content: currentFileContent,
					cursorOffset,
				});
				if (nextSnippet) {
					recentSnippetsRef.current = [
						...recentSnippetsRef.current.filter(
							(snippet) => snippet.key !== nextSnippet.key,
						),
						nextSnippet,
					].slice(-RECENT_SNIPPET_LIMIT);
				}
				logNextEditDebug("request started", {
					filePath,
					cursorOffset,
					contentLength: currentFileContent.length,
					recentSnippetCount: recentSnippetsRef.current.length,
					editHistoryCount: editHistoryRef.current.length,
					recentSnippetKeys: recentSnippetsRef.current.map(
						(snippet) => snippet.key,
					),
					editHistoryPreview: editHistoryRef.current
						.slice(-2)
						.map((entry) => entry.slice(0, 160)),
				});

				const result = await completeMutation.mutateAsync({
					filePath,
					currentFileContent,
					cursorOffset,
					recentSnippets: recentSnippetsRef.current.map((snippet) => ({
						filePath: snippet.filePath,
						content: snippet.content,
					})),
					editHistory: editHistoryRef.current,
				});
				logNextEditDebug("request completed", {
					filePath,
					hasInsertText: Boolean(result.insertText),
					insertTextLength: result.insertText?.length ?? 0,
					insertTextPreview: result.insertText?.slice(0, 120) ?? null,
					cursorOffset,
				});
				return result.insertText;
			} catch (error) {
				console.log("[NextEdit] request failed", {
					filePath,
					error,
				});
				return null;
			}
		},
		[
			completeMutation,
			filePath,
			flushPendingEditHistory,
			inceptionStatus?.authenticated,
			isAvailable,
			nextEditConfig?.enabled,
		],
	);

	return {
		isAvailable,
		requestInlineCompletion,
		syncDocumentSnapshot,
		trackDocumentChange,
	};
}
