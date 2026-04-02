import type { ReactNode } from "react";

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createSearchRegExp({
	query,
	isRegex,
	caseSensitive,
}: {
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
}): RegExp | null {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return null;
	}

	try {
		return new RegExp(
			isRegex ? trimmedQuery : escapeRegExp(trimmedQuery),
			caseSensitive ? "gu" : "giu",
		);
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
	}: {
		query: string;
		replacement: string;
		line: number;
		column: number;
		isRegex: boolean;
		caseSensitive: boolean;
	},
): string | null {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
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
	}: {
		query: string;
		replacement: string;
		line: number;
		isRegex: boolean;
		caseSensitive: boolean;
	},
): string | null {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
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

export function highlightSearchText(
	text: string,
	{
		query,
		isRegex,
		caseSensitive,
	}: {
		query: string;
		isRegex: boolean;
		caseSensitive: boolean;
	},
): ReactNode {
	const regex = createSearchRegExp({
		query,
		isRegex,
		caseSensitive,
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
