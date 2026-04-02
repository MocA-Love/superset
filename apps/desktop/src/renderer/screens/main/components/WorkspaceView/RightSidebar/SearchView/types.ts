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

export interface SearchLineResult {
	id: string;
	absolutePath: string;
	relativePath: string;
	name: string;
	line: number;
	preview: string;
	matches: SearchContentResult[];
}

export interface SearchTreeFileNode {
	id: string;
	type: "file";
	path: string;
	group: SearchResultGroup;
}

export interface SearchTreeFolderNode {
	id: string;
	type: "folder";
	path: string;
	name: string;
	matchCount: number;
	children: SearchTreeNode[];
}

export type SearchTreeNode = SearchTreeFileNode | SearchTreeFolderNode;

export type SearchResultViewMode = "tree" | "list";
