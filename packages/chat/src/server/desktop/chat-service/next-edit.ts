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

export interface FimResolvedRequest {
	payload: Record<string, unknown>;
	suffix: string;
}

const RECENT_SNIPPET_LIMIT = 5;
const EDITABLE_REGION_PREVIOUS_LINES = 5;
const EDITABLE_REGION_NEXT_LINES = 10;
const FIM_PREFIX_MAX_CHARS = 6000;
const FIM_SUFFIX_MAX_CHARS = 3000;
const FIM_MAX_TOKENS = 512;
const FIM_TEMPERATURE = 0.0;
const FIM_TOP_P = 1.0;
const FIM_PRESENCE_PENALTY = 1.5;
const INLINE_COMPLETION_INSTRUCTION = [
	"You are generating an inline tab completion for a code editor.",
	"Prefer preserving all existing code exactly.",
	"When possible, continue by appending code at the cursor instead of rewriting earlier text.",
	"Return the updated <|code_to_edit|> region in triple backticks.",
].join(" ");

function logNextEditServer(
	message: string,
	details?: Record<string, unknown>,
): void {
	if (details) {
		console.log(`[NextEditServer] ${message}`, details);
		return;
	}

	console.log(`[NextEditServer] ${message}`);
}

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

function normalizeGeneratedText(text: string): string {
	const fencedMatch = text.match(/```(?:[\w-]+)?\n([\s\S]*?)\n?```/);
	return (fencedMatch?.[1] ?? text)
		.replaceAll("<|cursor|>", "")
		.replace(/\r\n/g, "\n");
}

function stripSuffixOverlap(insertText: string, suffix: string): string {
	const maxOverlap = Math.min(insertText.length, suffix.length);
	for (let size = maxOverlap; size > 0; size -= 1) {
		if (insertText.endsWith(suffix.slice(0, size))) {
			return insertText.slice(0, insertText.length - size);
		}
	}

	return insertText;
}

export function buildFimRequest(
	input: NextEditRequestInput,
	config: NextEditConfig,
): FimResolvedRequest {
	const cursorOffset = clampCursorOffset(
		input.currentFileContent,
		input.cursorOffset,
	);
	const prompt = input.currentFileContent.slice(
		Math.max(0, cursorOffset - FIM_PREFIX_MAX_CHARS),
		cursorOffset,
	);
	const suffix = input.currentFileContent.slice(
		cursorOffset,
		Math.min(input.currentFileContent.length, cursorOffset + FIM_SUFFIX_MAX_CHARS),
	);

	const payload: Record<string, unknown> = {
		model: config.model,
		prompt,
		suffix,
		max_tokens: Math.min(config.maxTokens, FIM_MAX_TOKENS),
		temperature: FIM_TEMPERATURE,
		top_p: FIM_TOP_P,
		presence_penalty: FIM_PRESENCE_PENALTY,
	};

	if (config.stop.length > 0) {
		payload.stop = config.stop;
	}

	logNextEditServer("fim request built", {
		filePath: input.filePath,
		cursorOffset,
		promptLength: prompt.length,
		suffixLength: suffix.length,
		model: config.model,
		maxTokens: Math.min(config.maxTokens, FIM_MAX_TOKENS),
	});

	return {
		payload,
		suffix,
	};
}

export function extractInsertTextFromFimResponse(args: {
	response: Record<string, unknown>;
	suffix: string;
}): string | null {
	const rawContent = extractTextResponse(args.response);
	if (!rawContent.trim()) {
		logNextEditServer("fim parser returned null: empty raw content", {
			responseKeys: Object.keys(args.response),
		});
		return null;
	}

	const candidate = normalizeGeneratedText(rawContent);
	const insertText = stripSuffixOverlap(candidate, args.suffix);
	logNextEditServer("fim parser completed", {
		candidateLength: candidate.length,
		insertTextLength: insertText.length,
		insertTextPreview: insertText.slice(0, 160),
	});
	return insertText.length > 0 ? insertText : null;
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
		INLINE_COMPLETION_INSTRUCTION,
		"",
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

	logNextEditServer("request built", {
		filePath: input.filePath,
		cursorOffset,
		recentSnippetCount: input.recentSnippets?.length ?? 0,
		editHistoryCount: input.editHistory?.length ?? 0,
		editableRegionPrefixLength: editableRegionPrefix.length,
		editableRegionSuffixLength: editableRegionSuffix.length,
		model: config.model,
		maxTokens: config.maxTokens,
		temperature: config.temperature,
		topP: config.topP,
		presencePenalty: config.presencePenalty,
		stopCount: config.stop.length,
		payloadPreview: String(content).slice(0, 400),
	});

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
		logNextEditServer("parser returned null: empty raw content", {
			responseKeys: Object.keys(args.response),
		});
		return null;
	}

	const candidate = normalizeGeneratedText(rawContent);

	if (
		candidate.startsWith(args.editableRegionPrefix) &&
		candidate.endsWith(args.editableRegionSuffix)
	) {
		const insertText = candidate.slice(
			args.editableRegionPrefix.length,
			candidate.length - args.editableRegionSuffix.length,
		);
		logNextEditServer("parser matched editable region", {
			candidateLength: candidate.length,
			insertTextLength: insertText.length,
			insertTextPreview: insertText.slice(0, 160),
		});
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
		logNextEditServer("parser matched suffix-only region", {
			candidateLength: candidate.length,
			insertTextLength: insertText.length,
			insertTextPreview: insertText.slice(0, 160),
		});
		return insertText.length > 0 ? insertText : null;
	}

	logNextEditServer("parser returned null: region mismatch", {
		candidatePreview: candidate.slice(0, 200),
		candidateLength: candidate.length,
		editableRegionPrefixPreview: args.editableRegionPrefix.slice(-120),
		editableRegionPrefixLength: args.editableRegionPrefix.length,
		editableRegionSuffixPreview: args.editableRegionSuffix.slice(0, 120),
		editableRegionSuffixLength: args.editableRegionSuffix.length,
	});

	return null;
}
