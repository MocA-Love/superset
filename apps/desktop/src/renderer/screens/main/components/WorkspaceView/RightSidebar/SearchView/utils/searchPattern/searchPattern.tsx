import type { ReactNode } from "react";

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSearchRegExp({
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
