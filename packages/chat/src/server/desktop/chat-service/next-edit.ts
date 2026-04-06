import { type NextEditConfig } from "./next-edit-config";

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
	linePrefix: string;
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
		...snippets.flatMap((snippet) => [
			"<|recently_viewed_code_snippet|>",
			`code_snippet_file_path: ${snippet.filePath}`,
			snippet.content,
			"<|/recently_viewed_code_snippet|>",
			"",
		]),
		"<|/recently_viewed_code_snippets|>",
	].join("\n");
}

function buildEditHistory(editHistory: NextEditRequestInput["editHistory"]): string {
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
	const lineStart =
		input.currentFileContent.lastIndexOf("\n", Math.max(0, cursorOffset - 1)) + 1;
	const currentLinePrefix = input.currentFileContent.slice(lineStart, cursorOffset);
	const filePrefix = input.currentFileContent.slice(0, lineStart);
	const fileSuffix = input.currentFileContent.slice(cursorOffset);

	const content = [
		buildRecentlyViewedSnippets(input.recentSnippets),
		"",
		"<|current_file_content|>",
		`current_file_path: ${input.filePath}`,
		filePrefix,
		"<|code_to_edit|>",
		`${currentLinePrefix}<|cursor|>`,
		"<|/code_to_edit|>",
		fileSuffix,
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
		linePrefix: currentLinePrefix,
	};
}

export function extractInsertTextFromNextEditResponse(args: {
	response: Record<string, unknown>;
	linePrefix: string;
}): string | null {
	const rawContent = extractTextResponse(args.response).trim();
	if (!rawContent) {
		return null;
	}

	const fencedMatch = rawContent.match(/```(?:[\w-]+)?\n?([\s\S]*?)```/);
	const candidate = (fencedMatch?.[1] ?? rawContent)
		.replaceAll("<|cursor|>", "")
		.replace(/\r\n/g, "\n");

	if (candidate.startsWith(args.linePrefix)) {
		const insertText = candidate.slice(args.linePrefix.length);
		return insertText.length > 0 ? insertText : null;
	}

	if (args.linePrefix.length === 0) {
		return candidate.length > 0 ? candidate : null;
	}

	return null;
}
