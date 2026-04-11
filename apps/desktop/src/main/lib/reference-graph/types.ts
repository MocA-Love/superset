/**
 * Types for the reference graph feature.
 * Shared between main process (graph building) and renderer (visualization).
 */

export interface ReferenceGraphNode {
	id: string;
	name: string;
	/** Symbol kind (function, class, variable, etc.) */
	kind: string;
	absolutePath: string;
	relativePath: string | null;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	/** Code snippet with context lines */
	codeSnippet: string;
	/** Language ID for syntax highlighting */
	languageId: string;
	/** Starting line number of the snippet in the file */
	snippetStartLine: number;
	/** Whether this is the root node (the queried symbol) */
	isRoot: boolean;
	/** Depth in the graph from root */
	depth: number;
}

export interface ReferenceGraphEdge {
	id: string;
	source: string;
	target: string;
}

export interface ReferenceGraphData {
	nodes: ReferenceGraphNode[];
	edges: ReferenceGraphEdge[];
}

export interface ReferenceGraphRequest {
	workspaceId: string;
	workspacePath: string;
	absolutePath: string;
	languageId: string;
	line: number;
	column: number;
	/** Max recursion depth (default 3) */
	maxDepth?: number;
	/** Max total nodes (default 100) */
	maxNodes?: number;
	/**
	 * Directory name segments to exclude from the graph.
	 * Glob-style patterns like "** /node_modules/**" are supported — the
	 * directory name is extracted and matched against path segments.
	 * Default: ["node_modules", "dist", ".git"]
	 */
	excludePatterns?: string[];
}
