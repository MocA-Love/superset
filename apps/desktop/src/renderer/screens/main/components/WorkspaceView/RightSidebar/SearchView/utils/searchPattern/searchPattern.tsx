import type { ReactNode } from "react";

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchPatternOptions {
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
}

export function createSearchRegExp({
	query,
	isRegex,
	caseSensitive,
	wholeWord = false,
	multiline = false,
}: SearchPatternOptions): RegExp | null {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return null;
	}

	try {
		let source = isRegex ? trimmedQuery : escapeRegExp(trimmedQuery);
		if (wholeWord) {
			source = `\\b(?:${source})\\b`;
		}
		let flags = caseSensitive ? "gu" : "giu";
		if (isRegex && multiline) {
			flags += "sm";
		}
		return new RegExp(source, flags);
	} catch {
		return null;
	}
}

function getContentIndexForLineColumn(
	content: string,
	line: number,
	column: number,
): number | null {
	if (line < 1 || column < 1) {
		return null;
	}

	let lineStartIndex = 0;
	let currentLine = 1;

	while (currentLine < line) {
		const nextLineBreak = content.indexOf("\n", lineStartIndex);
		if (nextLineBreak === -1) {
			return null;
		}
		lineStartIndex = nextLineBreak + 1;
		currentLine += 1;
	}

	return lineStartIndex + column - 1;
}

export function replaceSingleSearchMatchInContent(
	content: string,
	{
		query,
		replacement,
		line,
		column,
		isRegex,
		caseSensitive,
		wholeWord = false,
		multiline = false,
	}: {
		query: string;
		replacement: string;
		line: number;
		column: number;
		isRegex: boolean;
		caseSensitive: boolean;
		wholeWord?: boolean;
		multiline?: boolean;
	},
): string | null {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
		wholeWord,
		multiline,
	});
	if (!regex) {
		return null;
	}

	const startIndex = getContentIndexForLineColumn(content, line, column);
	if (startIndex === null) {
		return null;
	}

	regex.lastIndex = startIndex;
	const match = regex.exec(content);
	if (!match || match.index !== startIndex) {
		return null;
	}

	const matchedText = match[0] ?? "";
	const replacementPattern = new RegExp(
		regex.source,
		regex.flags.replace("g", ""),
	);
	const nextText = matchedText.replace(replacementPattern, replacement);

	return (
		content.slice(0, startIndex) +
		nextText +
		content.slice(startIndex + matchedText.length)
	);
}

export function replaceSearchMatchesInLineInContent(
	content: string,
	{
		query,
		replacement,
		line,
		isRegex,
		caseSensitive,
		wholeWord = false,
		multiline = false,
	}: {
		query: string;
		replacement: string;
		line: number;
		isRegex: boolean;
		caseSensitive: boolean;
		wholeWord?: boolean;
		multiline?: boolean;
	},
): string | null {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
		wholeWord,
		multiline,
	});
	if (!regex) {
		return null;
	}

	const lineStartIndex = getContentIndexForLineColumn(content, line, 1);
	if (lineStartIndex === null) {
		return null;
	}

	const nextLineBreak = content.indexOf("\n", lineStartIndex);
	const lineEndIndex = nextLineBreak === -1 ? content.length : nextLineBreak;
	const lineContent = content.slice(lineStartIndex, lineEndIndex);
	const nextLineContent = lineContent.replace(regex, replacement);

	if (nextLineContent === lineContent) {
		return null;
	}

	return (
		content.slice(0, lineStartIndex) +
		nextLineContent +
		content.slice(lineEndIndex)
	);
}

export function getSearchValidationError(
	query: string,
	isRegex: boolean,
): string | null {
	if (!isRegex || query.trim().length === 0) {
		return null;
	}

	try {
		new RegExp(query, "u");
		return null;
	} catch (error) {
		return error instanceof Error
			? error.message
			: "Invalid regular expression";
	}
}

export interface SearchLineSegment {
	kind: "text" | "match-before" | "match-after";
	text: string;
}

/**
 * Given a single line and a replacement, returns a segment list suitable
 * for rendering an inline before/after diff. For each match on the line we
 * emit the original text (`match-before`) followed by what it would become
 * (`match-after`), interleaved with the surrounding untouched text. Returns
 * `null` when the regex can't be compiled; callers should fall through to
 * plain highlight rendering in that case.
 */
export function buildLineReplacementSegments(
	line: string,
	{
		query,
		replacement,
		isRegex,
		caseSensitive,
		wholeWord = false,
		multiline = false,
	}: SearchPatternOptions & { replacement: string },
): SearchLineSegment[] | null {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
		wholeWord,
		multiline,
	});
	if (!regex) {
		return null;
	}

	const segments: SearchLineSegment[] = [];
	let cursor = 0;
	let match = regex.exec(line);

	while (match) {
		const matchText = match[0] ?? "";
		const matchLength = matchText.length > 0 ? matchText.length : 1;
		const endIndex = match.index + matchLength;

		if (match.index > cursor) {
			segments.push({ kind: "text", text: line.slice(cursor, match.index) });
		}
		segments.push({ kind: "match-before", text: matchText });
		// Build the after-text by running the matched slice through
		// String.prototype.replace so capture groups in `replacement` resolve
		// ($1, $&, etc.) using the same semantics as the backend.
		const singleShotRegex = new RegExp(
			regex.source,
			regex.flags.replace("g", ""),
		);
		segments.push({
			kind: "match-after",
			text: matchText.replace(singleShotRegex, replacement),
		});

		cursor = endIndex;
		if (matchText.length === 0) {
			regex.lastIndex += 1;
		}
		match = regex.exec(line);
	}

	if (segments.length === 0) {
		return null;
	}
	if (cursor < line.length) {
		segments.push({ kind: "text", text: line.slice(cursor) });
	}

	return segments;
}

export function highlightSearchText(
	text: string,
	{
		query,
		isRegex,
		caseSensitive,
		wholeWord = false,
		multiline = false,
	}: {
		query: string;
		isRegex: boolean;
		caseSensitive: boolean;
		wholeWord?: boolean;
		multiline?: boolean;
	},
): ReactNode {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
		wholeWord,
		multiline,
	});
	if (!regex) {
		return text;
	}

	const nodes: ReactNode[] = [];
	let cursor = 0;
	let match = regex.exec(text);

	while (match) {
		const matchText = match[0] ?? "";
		const matchLength = matchText.length > 0 ? matchText.length : 1;
		const endIndex = match.index + matchLength;

		if (match.index > cursor) {
			nodes.push(
				<span key={`text-${cursor}`}>{text.slice(cursor, match.index)}</span>,
			);
		}

		nodes.push(
			<mark
				key={`mark-${match.index}-${endIndex}`}
				className="rounded bg-[var(--highlight-match)] px-0.5 text-foreground"
			>
				{text.slice(match.index, endIndex)}
			</mark>,
		);

		cursor = endIndex;
		if (matchText.length === 0) {
			regex.lastIndex += 1;
		}
		match = regex.exec(text);
	}

	if (nodes.length === 0) {
		return text;
	}

	if (cursor < text.length) {
		nodes.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
	}

	return nodes;
}
