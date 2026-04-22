interface ParsedQuickOpenQuery {
	searchQuery: string;
	line?: number;
	column?: number;
}

export function parseQuickOpenQuery(query: string): ParsedQuickOpenQuery {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return { searchQuery: "" };
	}

	// Try to extract :line[:column] from the end of the query.
	// We need to handle paths like "foo.ts:123" and "foo.ts:123:45"
	// but NOT "C:\path" (drive letter colon).
	const lastColon = trimmedQuery.lastIndexOf(":");
	if (lastColon <= 0) {
		return { searchQuery: trimmedQuery };
	}

	const afterLastColon = trimmedQuery.slice(lastColon + 1);
	if (!/^\d+$/.test(afterLastColon)) {
		return { searchQuery: trimmedQuery };
	}

	const maybeColumn = Number.parseInt(afterLastColon, 10);

	// Check if there's another colon:digits before this one (line:column pattern)
	const beforeLastColon = trimmedQuery.slice(0, lastColon);
	const secondLastColon = beforeLastColon.lastIndexOf(":");
	let pathPart: string;
	let line: number;
	let column: number | undefined;

	if (
		secondLastColon > 0 &&
		/^\d+$/.test(beforeLastColon.slice(secondLastColon + 1))
	) {
		// Pattern: path:line:column
		const maybeLine = Number.parseInt(
			beforeLastColon.slice(secondLastColon + 1),
			10,
		);
		pathPart = beforeLastColon.slice(0, secondLastColon).trim();
		line = maybeLine;
		column = maybeColumn;

		if (!pathPart || line <= 0 || column <= 0) {
			return { searchQuery: trimmedQuery };
		}
	} else {
		// Pattern: path:line
		pathPart = beforeLastColon.trim();
		line = maybeColumn;

		if (!pathPart || line <= 0) {
			return { searchQuery: trimmedQuery };
		}
	}

	return {
		searchQuery: pathPart,
		line,
		column,
	};
}
