export interface SearchContentResult {
	id: string;
	absolutePath: string;
	relativePath: string;
	name: string;
	line: number;
	column: number;
	preview: string;
}

export interface SearchResultGroup {
	absolutePath: string;
	relativePath: string;
	name: string;
	matches: SearchContentResult[];
}
