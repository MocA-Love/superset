import {
	Background,
	Controls,
	type Edge,
	type Node,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { ReferenceNode } from "./ReferenceNode";

const elk = new ELK();

interface ReferenceGraphPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
}

const NODE_WIDTH = 350;
const NODE_HEIGHT = 200;

const nodeTypes = { referenceNode: ReferenceNode };

async function layoutGraph(
	nodes: Node[],
	edges: Edge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.layered.spacing.nodeNodeBetweenLayers": "80",
			"elk.spacing.nodeNode": "40",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
		},
		children: nodes.map((n) => ({
			id: n.id,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		})),
		edges: edges.map((e) => ({
			id: e.id,
			sources: [e.source],
			targets: [e.target],
		})),
	};

	const layoutResult = await elk.layout(graph);

	const layoutedNodes = nodes.map((node) => {
		const elkNode = layoutResult.children?.find((n) => n.id === node.id);
		return {
			...node,
			position: {
				x: elkNode?.x ?? 0,
				y: elkNode?.y ?? 0,
			},
		};
	});

	return { nodes: layoutedNodes, edges };
}

function ReferenceGraphInner({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: ReferenceGraphPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const refGraphState = pane?.referenceGraph;
	const { fitView } = useReactFlow();

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [maxDepth, setMaxDepth] = useState(3);

	const buildGraphMutation =
		electronTrpc.referenceGraph.buildGraph.useMutation();
	const mutateAsyncRef = useRef(buildGraphMutation.mutateAsync);
	mutateAsyncRef.current = buildGraphMutation.mutateAsync;

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);

	const handleNodeDoubleClick = useCallback(
		(absolutePath: string, line: number) => {
			addFileViewerPane(workspaceId, {
				filePath: absolutePath,
				line,
				isPinned: false,
			});
		},
		[addFileViewerPane, workspaceId],
	);

	const loadGraph = useCallback(async () => {
		if (!refGraphState) return;

		setIsLoading(true);
		setError(null);

		try {
			const graph = await mutateAsyncRef.current({
				workspaceId,
				absolutePath: refGraphState.absolutePath,
				languageId: refGraphState.languageId,
				line: refGraphState.line,
				column: refGraphState.column,
				maxDepth,
			});

			const flowNodes: Node[] = graph.nodes.map((n) => ({
				id: n.id,
				type: "referenceNode",
				position: { x: 0, y: 0 },
				data: {
					...n,
					onDoubleClick: handleNodeDoubleClick,
				},
			}));

			const flowEdges: Edge[] = graph.edges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				animated: true,
				style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
			}));

			if (flowNodes.length > 0) {
				const layouted = await layoutGraph(flowNodes, flowEdges);
				setNodes(layouted.nodes);
				setEdges(layouted.edges);
				setTimeout(() => fitView({ padding: 0.2 }), 50);
			} else {
				setNodes([]);
				setEdges([]);
				setError("No references found for this symbol.");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to build reference graph",
			);
		} finally {
			setIsLoading(false);
		}
	}, [
		refGraphState,
		workspaceId,
		maxDepth,
		handleNodeDoubleClick,
		setNodes,
		setEdges,
		fitView,
	]);

	// Load graph on mount or when params change
	useEffect(() => {
		void loadGraph();
	}, [loadGraph]);

	const depthOptions = useMemo(
		() => [1, 2, 3, 4, 5].map((d) => ({ value: d, label: `Depth: ${d}` })),
		[],
	);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center gap-2 px-2">
					<span className="truncate text-sm text-muted-foreground">
						Reference Graph
					</span>
					{refGraphState && (
						<span className="truncate text-xs text-muted-foreground/60">
							{refGraphState.absolutePath.split("/").pop()}:{refGraphState.line}
						</span>
					)}
					<div className="flex items-center gap-1 ml-auto">
						<select
							value={maxDepth}
							onChange={(e) => setMaxDepth(Number(e.target.value))}
							className="h-6 rounded border border-border bg-background px-1 text-xs text-foreground"
						>
							{depthOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={() => void loadGraph()}
							disabled={isLoading}
							className="h-6 rounded border border-border bg-background px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
						>
							{isLoading ? "Loading..." : "Refresh"}
						</button>
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						onPopOut={handlers.onPopOut}
					/>
				</div>
			)}
		>
			<div className="w-full h-full relative">
				{isLoading && nodes.length === 0 && (
					<div className="absolute inset-0 flex items-center justify-center z-10">
						<div className="text-sm text-muted-foreground">
							Building reference graph...
						</div>
					</div>
				)}
				{error && nodes.length === 0 && (
					<div className="absolute inset-0 flex items-center justify-center z-10">
						<div className="text-sm text-destructive">{error}</div>
					</div>
				)}
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					nodeTypes={nodeTypes}
					fitView
					panOnDrag
					panOnScroll
					zoomOnDoubleClick={false}
					deleteKeyCode={null}
					minZoom={0.1}
					maxZoom={2}
					proOptions={{ hideAttribution: true }}
				>
					<Background bgColor="var(--sidebar)" color="var(--border)" gap={20} />
					<Controls
						showInteractive={false}
						className="[&>button]:!bg-background [&>button]:!border-border [&>button]:!fill-foreground"
					/>
				</ReactFlow>
			</div>
		</BasePaneWindow>
	);
}

export function ReferenceGraphPane(props: ReferenceGraphPaneProps) {
	return (
		<ReactFlowProvider>
			<ReferenceGraphInner {...props} />
		</ReactFlowProvider>
	);
}
