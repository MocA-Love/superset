import type { StreamParser } from "@codemirror/language";

const GRAPHQL_KEYWORDS = new Set([
	"directive",
	"enum",
	"extend",
	"fragment",
	"implements",
	"input",
	"interface",
	"mutation",
	"on",
	"query",
	"repeatable",
	"scalar",
	"schema",
	"subscription",
	"type",
	"union",
]);

const GRAPHQL_ATOMS = new Set(["false", "null", "true"]);

interface GraphqlState {
	inBlockString: boolean;
	inString: boolean;
}

export const graphqlStreamLanguage: StreamParser<GraphqlState> = {
	name: "graphql",
	startState: () => ({
		inBlockString: false,
		inString: false,
	}),
	token(stream, state) {
		if (state.inBlockString) {
			while (!stream.eol()) {
				if (stream.match('"""')) {
					state.inBlockString = false;
					break;
				}
				stream.next();
			}

			return "string";
		}

		if (state.inString) {
			let escaped = false;

			while (!stream.eol()) {
				const next = stream.next();
				if (next === '"' && !escaped) {
					state.inString = false;
					break;
				}
				escaped = !escaped && next === "\\";
			}

			return "string";
		}

		if (stream.eatSpace()) return null;

		if (stream.match('"""')) {
			while (!stream.eol()) {
				if (stream.match('"""')) {
					return "string";
				}
				stream.next();
			}

			state.inBlockString = true;
			return "string";
		}

		const next = stream.next();
		if (!next) return null;

		if (next === "#") {
			stream.skipToEnd();
			return "comment";
		}

		if (next === '"') {
			let escaped = false;

			while (!stream.eol()) {
				const char = stream.next();
				if (char === '"' && !escaped) {
					return "string";
				}
				escaped = !escaped && char === "\\";
			}

			state.inString = true;
			return "string";
		}

		if (next === "$") {
			stream.eatWhile(/[_0-9A-Za-z]/);
			return "variableName";
		}

		if (next === "@") {
			stream.eatWhile(/[_0-9A-Za-z]/);
			return "meta";
		}

		if (next === "-" && /\d/.test(stream.peek() ?? "")) {
			stream.eatWhile(/\d/);
			if (stream.peek() === ".") {
				stream.next();
				stream.eatWhile(/\d/);
			}
			return "number";
		}

		if (/\d/.test(next)) {
			stream.eatWhile(/\d/);
			if (stream.peek() === ".") {
				stream.next();
				stream.eatWhile(/\d/);
			}
			return "number";
		}

		if (/[A-Za-z_]/.test(next)) {
			stream.eatWhile(/[_0-9A-Za-z]/);
			const word = stream.current();

			if (GRAPHQL_KEYWORDS.has(word)) return "keyword";
			if (GRAPHQL_ATOMS.has(word)) return "atom";
			return /^[A-Z]/.test(word) ? "typeName" : "variableName";
		}

		return null;
	},
	languageData: {
		commentTokens: { line: "#" },
	},
};

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/**
 * Column tags cycle through existing syntax highlight token types so that each
 * column gets a distinct color from the theme without any extra CSS.
 */
const COLUMN_TAGS = [
	"string",
	"keyword",
	"typeName",
	"variableName",
	"number",
	"className",
] as const;

interface CsvState {
	column: number;
	inQuote: boolean;
}

function createCsvStreamLanguage(
	delimiter: string,
): StreamParser<CsvState> {
	return {
		name: delimiter === "\t" ? "tsv" : "csv",
		startState: () => ({ column: 0, inQuote: false }),
		token(stream, state) {
			// Start of line resets column
			if (stream.sol() && !state.inQuote) {
				state.column = 0;
			}

			const tag = COLUMN_TAGS[state.column % COLUMN_TAGS.length];

			// Inside a quoted field
			if (state.inQuote) {
				while (!stream.eol()) {
					if (stream.next() === '"') {
						// Escaped quote ("") → stay in quote
						if (stream.peek() === '"') {
							stream.next();
						} else {
							state.inQuote = false;
							// Consume trailing delimiter if present
							if (stream.peek() === delimiter) {
								stream.next();
								state.column++;
							}
							return tag;
						}
					}
				}
				return tag;
			}

			// Opening quote at start of field
			if (stream.peek() === '"') {
				stream.next();
				state.inQuote = true;
				// Consume until closing quote or end of line
				while (!stream.eol()) {
					if (stream.next() === '"') {
						if (stream.peek() === '"') {
							stream.next();
						} else {
							state.inQuote = false;
							if (stream.peek() === delimiter) {
								stream.next();
								state.column++;
							}
							return tag;
						}
					}
				}
				return tag;
			}

			// Unquoted field — consume until delimiter or eol
			while (!stream.eol()) {
				if (stream.peek() === delimiter) {
					stream.next();
					state.column++;
					return tag;
				}
				stream.next();
			}
			return tag;
		},
	};
}

export const csvStreamLanguage = createCsvStreamLanguage(",");
export const tsvStreamLanguage = createCsvStreamLanguage("\t");

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

const MAKEFILE_DIRECTIVES = new Set([
	"-include",
	"define",
	"else",
	"endef",
	"endif",
	"export",
	"ifdef",
	"ifndef",
	"ifeq",
	"ifneq",
	"include",
	"override",
	"private",
	"sinclude",
	"undefine",
	"unexport",
	"vpath",
]);

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAKEFILE_DIRECTIVE_PATTERN = new RegExp(
	`^\\s*(?:${[...MAKEFILE_DIRECTIVES].map(escapeRegex).join("|")})\\b`,
);

export const makefileStreamLanguage: StreamParser<null> = {
	name: "makefile",
	token(stream) {
		if (stream.sol()) {
			if (stream.peek() === "\t") {
				stream.skipToEnd();
				return "meta";
			}

			if (stream.match(MAKEFILE_DIRECTIVE_PATTERN)) {
				return "keyword";
			}

			if (stream.match(/^\s*[A-Za-z_][A-Za-z0-9_.-]*(?=\s*(?::=|\+=|\?=|=))/)) {
				return "variableName";
			}

			if (stream.match(/^\s*[^:=#\s][^:=#]*(?=\s*:)/)) {
				return "def";
			}
		}

		if (stream.eatSpace()) return null;

		if (stream.match(/^\$\(([^)]+)\)/) || stream.match(/^\$\{([^}]+)\}/)) {
			return "variableName";
		}

		const next = stream.next();
		if (!next) return null;

		if (next === "#") {
			stream.skipToEnd();
			return "comment";
		}

		if (next === ":" && stream.peek() === "=") {
			stream.next();
			return "operator";
		}

		if ((next === "+" || next === "?") && stream.peek() === "=") {
			stream.next();
			return "operator";
		}

		if (next === "=") {
			return "operator";
		}

		if (/[A-Za-z_.-]/.test(next)) {
			stream.eatWhile(/[A-Za-z0-9_.-]/);
			return MAKEFILE_DIRECTIVES.has(stream.current()) ? "keyword" : null;
		}

		return null;
	},
	languageData: {
		commentTokens: { line: "#" },
	},
};
