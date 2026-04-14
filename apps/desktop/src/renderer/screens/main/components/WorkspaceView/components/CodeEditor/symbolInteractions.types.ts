export interface SymbolPosition {
	line: number;
	column: number;
}

export interface SymbolRange {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

export interface SymbolMarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export interface SymbolHoverResult {
	contents: SymbolMarkupContent[];
	range: SymbolRange | null;
}
