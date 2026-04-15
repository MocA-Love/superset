import fs from "node:fs/promises";
import path from "node:path";
import { resolveReferenceGraphLanguageId } from "shared/language-registry";
import { languageServiceManager } from "../language-services/manager";
import type {
	LanguageServiceCallHierarchyItem,
	LanguageServiceLocation,
} from "../language-services/types";
import { toRelativeWorkspacePath } from "../language-services/utils";
import type {
	ReferenceGraphData,
	ReferenceGraphEdge,
	ReferenceGraphNode,
	ReferenceGraphRequest,
} from "./types";

const CONTEXT_LINES = 3;

function makeNodeId(absolutePath: string, line: number, column: number) {
	return `${absolutePath}:${line}:${column}`;
}

function getLanguageIdFromPath(filePath: string): string {
	return resolveReferenceGraphLanguageId(filePath);
}

async function getCodeSnippet(
	absolutePath: string,
	line: number,
	endLine: number,
): Promise<{ snippet: string; startLine: number } | null> {
	try {
		const content = await fs.readFile(absolutePath, "utf8");
		const lines = content.split("\n");
		const startLine = Math.max(0, line - 1 - CONTEXT_LINES);
		const finalLine = Math.min(lines.length, endLine + CONTEXT_LINES);
		const snippet = lines.slice(startLine, finalLine).join("\n");
		return { snippet, startLine: startLine + 1 };
	} catch {
		return null;
	}
}

/**
 * Check if a file path should be excluded from the graph.
 * Patterns are matched against path segments — e.g. "node_modules"
 * matches any path containing a "node_modules" directory segment.
 */
function shouldExclude(
	absolutePath: string,
	workspacePath: string,
	excludePatterns: string[],
): boolean {
	const relative = path.relative(workspacePath, absolutePath);
	const segments = relative.split(path.sep);
	for (const pattern of excludePatterns) {
		// Extract the directory name from glob patterns like "**/node_modules/**"
		const dirName = pattern.replace(/\*\*\//g, "").replace(/\/\*\*/g, "");
		if (segments.includes(dirName)) {
			return true;
		}
	}
	return false;
}

export async function buildReferenceGraph(
	request: ReferenceGraphRequest,
): Promise<ReferenceGraphData> {
	const maxDepth = request.maxDepth ?? 3;
	const maxNodes = request.maxNodes ?? 100;
	const excludePatterns = request.excludePatterns ?? [
		"**/node_modules/**",
		"**/dist/**",
		"**/.git/**",
	];

	const nodes = new Map<string, ReferenceGraphNode>();
	const edges = new Map<string, ReferenceGraphEdge>();

	// Try call hierarchy first (works for functions/methods)
	const callHierarchyItems = await languageServiceManager.prepareCallHierarchy({
		workspaceId: request.workspaceId,
		workspacePath: request.workspacePath,
		absolutePath: request.absolutePath,
		languageId: request.languageId,
		line: request.line,
		column: request.column,
	});

	if (callHierarchyItems && callHierarchyItems.length > 0) {
		// Build from call hierarchy
		const rootItem = callHierarchyItems[0];
		const rootNodeId = makeNodeId(
			rootItem.absolutePath,
			rootItem.line,
			rootItem.column,
		);
		await addNodeFromCallHierarchyItem(
			nodes,
			rootItem,
			rootNodeId,
			request.workspacePath,
			true,
			0,
		);

		await buildCallHierarchyGraph(
			request,
			rootItem,
			rootNodeId,
			nodes,
			edges,
			1,
			maxDepth,
			maxNodes,
			excludePatterns,
		);
	} else {
		// Fall back to references
		const rootNodeId = makeNodeId(
			request.absolutePath,
			request.line,
			request.column,
		);
		const snippet = await getCodeSnippet(
			request.absolutePath,
			request.line,
			request.line,
		);
		nodes.set(rootNodeId, {
			id: rootNodeId,
			name: "Symbol",
			kind: "unknown",
			absolutePath: request.absolutePath,
			relativePath: toRelativeWorkspacePath(
				request.workspacePath,
				request.absolutePath,
			),
			line: request.line,
			column: request.column,
			endLine: request.line,
			endColumn: request.column,
			codeSnippet: snippet?.snippet ?? "",
			languageId: getLanguageIdFromPath(request.absolutePath),
			snippetStartLine: snippet?.startLine ?? request.line,
			isRoot: true,
			depth: 0,
		});

		await buildReferencesGraph(
			request,
			rootNodeId,
			nodes,
			edges,
			1,
			maxDepth,
			maxNodes,
			excludePatterns,
		);
	}

	return {
		nodes: Array.from(nodes.values()),
		edges: Array.from(edges.values()),
	};
}

async function buildCallHierarchyGraph(
	request: ReferenceGraphRequest,
	item: LanguageServiceCallHierarchyItem,
	nodeId: string,
	nodes: Map<string, ReferenceGraphNode>,
	edges: Map<string, ReferenceGraphEdge>,
	currentDepth: number,
	maxDepth: number,
	maxNodes: number,
	excludePatterns: string[],
): Promise<void> {
	if (currentDepth > maxDepth || nodes.size >= maxNodes) return;

	const incomingCalls = await languageServiceManager.getIncomingCalls({
		workspaceId: request.workspaceId,
		languageId: request.languageId,
		item,
	});

	if (!incomingCalls) return;

	const pendingItems: Array<{
		item: LanguageServiceCallHierarchyItem;
		nodeId: string;
	}> = [];

	for (const call of incomingCalls) {
		if (nodes.size >= maxNodes) break;
		if (
			shouldExclude(
				call.from.absolutePath,
				request.workspacePath,
				excludePatterns,
			)
		)
			continue;

		const callerNodeId = makeNodeId(
			call.from.absolutePath,
			call.from.line,
			call.from.column,
		);

		if (!nodes.has(callerNodeId)) {
			await addNodeFromCallHierarchyItem(
				nodes,
				call.from,
				callerNodeId,
				request.workspacePath,
				false,
				currentDepth,
			);
			pendingItems.push({ item: call.from, nodeId: callerNodeId });
		}

		const edgeId = `${callerNodeId}->${nodeId}`;
		if (!edges.has(edgeId)) {
			edges.set(edgeId, {
				id: edgeId,
				source: callerNodeId,
				target: nodeId,
			});
		}
	}

	// Recurse into callers sequentially to respect maxNodes budget
	for (const { item, nodeId: callerId } of pendingItems) {
		if (nodes.size >= maxNodes) break;
		await buildCallHierarchyGraph(
			request,
			item,
			callerId,
			nodes,
			edges,
			currentDepth + 1,
			maxDepth,
			maxNodes,
			excludePatterns,
		);
	}
}

async function buildReferencesGraph(
	request: ReferenceGraphRequest,
	rootNodeId: string,
	nodes: Map<string, ReferenceGraphNode>,
	edges: Map<string, ReferenceGraphEdge>,
	currentDepth: number,
	maxDepth: number,
	maxNodes: number,
	excludePatterns: string[],
): Promise<void> {
	if (currentDepth > maxDepth || nodes.size >= maxNodes) return;

	const rootNode = nodes.get(rootNodeId);
	if (!rootNode) return;

	const references = await languageServiceManager.findReferences({
		workspaceId: request.workspaceId,
		workspacePath: request.workspacePath,
		absolutePath: rootNode.absolutePath,
		languageId: request.languageId,
		line: rootNode.line,
		column: rootNode.column,
	});

	if (!references) return;

	for (const ref of references) {
		if (nodes.size >= maxNodes) break;
		if (shouldExclude(ref.absolutePath, request.workspacePath, excludePatterns))
			continue;

		const refNodeId = makeNodeId(ref.absolutePath, ref.line, ref.column);

		// Skip self-references
		if (refNodeId === rootNodeId) continue;

		if (!nodes.has(refNodeId)) {
			await addNodeFromLocation(
				nodes,
				ref,
				refNodeId,
				request.workspacePath,
				currentDepth,
			);
		}

		const edgeId = `${rootNodeId}->${refNodeId}`;
		if (!edges.has(edgeId)) {
			edges.set(edgeId, {
				id: edgeId,
				source: rootNodeId,
				target: refNodeId,
			});
		}
	}
}

async function addNodeFromCallHierarchyItem(
	nodes: Map<string, ReferenceGraphNode>,
	item: LanguageServiceCallHierarchyItem,
	nodeId: string,
	workspacePath: string,
	isRoot: boolean,
	depth: number,
): Promise<void> {
	const snippet = await getCodeSnippet(
		item.absolutePath,
		item.line,
		item.endLine,
	);
	nodes.set(nodeId, {
		id: nodeId,
		name: item.name,
		kind: item.kind,
		absolutePath: item.absolutePath,
		relativePath: toRelativeWorkspacePath(workspacePath, item.absolutePath),
		line: item.line,
		column: item.column,
		endLine: item.endLine,
		endColumn: item.endColumn,
		codeSnippet: snippet?.snippet ?? "",
		languageId: getLanguageIdFromPath(item.absolutePath),
		snippetStartLine: snippet?.startLine ?? item.line,
		isRoot,
		depth,
	});
}

async function addNodeFromLocation(
	nodes: Map<string, ReferenceGraphNode>,
	location: LanguageServiceLocation,
	nodeId: string,
	workspacePath: string,
	depth: number,
): Promise<void> {
	const snippet = await getCodeSnippet(
		location.absolutePath,
		location.line,
		location.endLine,
	);
	nodes.set(nodeId, {
		id: nodeId,
		name: path.basename(location.absolutePath),
		kind: "reference",
		absolutePath: location.absolutePath,
		relativePath: toRelativeWorkspacePath(workspacePath, location.absolutePath),
		line: location.line,
		column: location.column,
		endLine: location.endLine,
		endColumn: location.endColumn,
		codeSnippet: snippet?.snippet ?? "",
		languageId: getLanguageIdFromPath(location.absolutePath),
		snippetStartLine: snippet?.startLine ?? location.line,
		isRoot: false,
		depth,
	});
}
