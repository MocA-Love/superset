import type { NextEditConfig } from "./next-edit-config";

export interface NextEditRequestInput {
	filePath: string;
	currentFileContent: string;
	cursorOffset: number;
	recentSnippets?: Array<{
		filePath: string;
		content: string;
	}>;
	editHistory?: string[];
}

export interface NextEditResolvedRequest {
	payload: Record<string, unknown>;
	editableRegionPrefix: string;
	editableRegionSuffix: string;
}

const RECENT_SNIPPET_LIMIT = 5;
const EDITABLE_REGION_PREVIOUS_LINES = 5;
const EDITABLE_REGION_NEXT_LINES = 10;

function getLineStartOffsets(content: string): number[] {
	const offsets = [0];
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10) {
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
		const lineStart = lineStarts[mid] ?? Number.POSITIVE_INFINITY;
		if (lineStart <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return high + 1;
}

function clampCursorOffset(content: string, offset: number): number {
	if (!Number.isFinite(offset)) {
		return content.length;
	}
	return Math.max(0, Math.min(content.length, Math.trunc(offset)));
}

function buildRecentlyViewedSnippets(
	snippets: NextEditRequestInput["recentSnippets"],
): string {
	if (!snippets || snippets.length === 0) {
		return "<|recently_viewed_code_snippets|>\n\n<|/recently_viewed_code_snippets|>";
	}

	return [
		"<|recently_viewed_code_snippets|>",
		...snippets
			.slice(-RECENT_SNIPPET_LIMIT)
			.flatMap((snippet) => [
				"<|recently_viewed_code_snippet|>",
				`code_snippet_file_path: ${snippet.filePath}`,
				snippet.content.trimEnd(),
				"<|/recently_viewed_code_snippet|>",
				"",
			]),
		"<|/recently_viewed_code_snippets|>",
	].join("\n");
}

function buildEditHistory(
	editHistory: NextEditRequestInput["editHistory"],
): string {
	if (!editHistory || editHistory.length === 0) {
		return "<|edit_diff_history|>\n\n<|/edit_diff_history|>";
	}

	return [
		"<|edit_diff_history|>",
		...editHistory,
		"<|/edit_diff_history|>",
	].join("\n");
}

function extractTextResponse(response: Record<string, unknown>): string {
	const choices = response.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return "";
	}

	const firstChoice =
		typeof choices[0] === "object" && choices[0] !== null
			? (choices[0] as Record<string, unknown>)
			: null;
	if (!firstChoice) {
		return "";
	}

	const message =
		typeof firstChoice.message === "object" && firstChoice.message !== null
			? (firstChoice.message as Record<string, unknown>)
			: null;

	if (message && typeof message.content === "string") {
		return message.content;
	}

	if (message && Array.isArray(message.content)) {
		return message.content
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}

				if (
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string"
				) {
					return (part as { text: string }).text;
				}

				return "";
			})
			.join("");
	}

	if (typeof firstChoice.text === "string") {
		return firstChoice.text;
	}

	return "";
}

export function buildNextEditRequest(
	input: NextEditRequestInput,
	config: NextEditConfig,
): NextEditResolvedRequest {
	const cursorOffset = clampCursorOffset(
		input.currentFileContent,
		input.cursorOffset,
	);
	const lineStarts = getLineStartOffsets(input.currentFileContent);
	const currentLineNumber = getLineNumberAtOffset(lineStarts, cursorOffset);
	const editableStartLine = Math.max(
		1,
		currentLineNumber - EDITABLE_REGION_PREVIOUS_LINES,
	);
	const editableEndLine = Math.min(
		lineStarts.length,
		currentLineNumber + EDITABLE_REGION_NEXT_LINES,
	);
	const editableRegionStart = lineStarts[editableStartLine - 1] ?? 0;
	const editableRegionEnd =
		editableEndLine < lineStarts.length
			? lineStarts[editableEndLine]
			: input.currentFileContent.length;
	const editableRegionPrefix = input.currentFileContent.slice(
		editableRegionStart,
		cursorOffset,
	);
	const editableRegionSuffix = input.currentFileContent.slice(
		cursorOffset,
		editableRegionEnd,
	);
	const filePrefix = input.currentFileContent.slice(0, editableRegionStart);
	const fileSuffix = input.currentFileContent.slice(editableRegionEnd);

	const content = [
		buildRecentlyViewedSnippets(input.recentSnippets),
		"",
		"<|current_file_content|>",
		`current_file_path: ${input.filePath}`,
		`${filePrefix}<|code_to_edit|>`,
		`${editableRegionPrefix}<|cursor|>${editableRegionSuffix}`,
		"<|/code_to_edit|>",
		`${fileSuffix}`,
		"<|/current_file_content|>",
		"",
		buildEditHistory(input.editHistory),
	].join("\n");

	const payload: Record<string, unknown> = {
		model: config.model,
		messages: [{ role: "user", content }],
		max_tokens: config.maxTokens,
		temperature: config.temperature,
		top_p: config.topP,
		presence_penalty: config.presencePenalty,
	};

	if (config.stop.length > 0) {
		payload.stop = config.stop;
	}

	return {
		payload,
		editableRegionPrefix,
		editableRegionSuffix,
	};
}

export function extractInsertTextFromNextEditResponse(args: {
	response: Record<string, unknown>;
	editableRegionPrefix: string;
	editableRegionSuffix: string;
}): string | null {
	const rawContent = extractTextResponse(args.response);
	if (!rawContent.trim()) {
		return null;
	}

	const fencedMatch = rawContent.match(/```(?:[\w-]+)?\n([\s\S]*?)\n?```/);
	const candidate = (fencedMatch?.[1] ?? rawContent)
		.replaceAll("<|cursor|>", "")
		.replace(/\r\n/g, "\n");

	if (
		candidate.startsWith(args.editableRegionPrefix) &&
		candidate.endsWith(args.editableRegionSuffix)
	) {
		const insertText = candidate.slice(
			args.editableRegionPrefix.length,
			candidate.length - args.editableRegionSuffix.length,
		);
		return insertText.length > 0 ? insertText : null;
	}

	if (
		args.editableRegionPrefix.length === 0 &&
		candidate.endsWith(args.editableRegionSuffix)
	) {
		const insertText = candidate.slice(
			0,
			candidate.length - args.editableRegionSuffix.length,
		);
		return insertText.length > 0 ? insertText : null;
	}

	return null;
}
