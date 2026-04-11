import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	getNodesBounds,
	getViewportForBounds,
	type Node,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { toPng } from "html-to-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTheme } from "renderer/stores/theme";
import { createShikiTheme } from "../../../../utils/code-theme/shiki-theme";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { ReferenceNode } from "./ReferenceNode";
import "./reference-graph.css";

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

const NODE_MIN_WIDTH = 280;
const NODE_MAX_WIDTH = 500;
const NODE_HEIGHT = 180;
const CHAR_WIDTH = 7.5;
const NODE_PADDING = 40;

const ELK_OPTIONS = {
	"elk.algorithm": "layered",
	"elk.direction": "DOWN",
	"elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
	"elk.spacing.nodeNode": "60",
	"elk.layered.spacing.nodeNodeBetweenLayers": "100",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.layered.nodePlacement.favorStraightEdges": "true",
	"elk.edgeRouting": "ORTHOGONAL",
	"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
	"elk.separateConnectedComponents": "true",
	"elk.spacing.componentComponent": "80",
};

const nodeTypes = { referenceNode: ReferenceNode };

function estimateNodeWidth(codeSnippet: string): number {
	const lines = codeSnippet.split("\n");
	const maxLineLength = Math.max(...lines.map((line) => line.length));
	const estimatedWidth = maxLineLength * CHAR_WIDTH + NODE_PADDING;
	return Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, estimatedWidth));
}

async function layoutGraph(
	nodes: Node[],
	edges: Edge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
	const graph = {
		id: "root",
		layoutOptions: ELK_OPTIONS,
		children: nodes.map((n) => ({
			id: n.id,
			width: estimateNodeWidth(
				(n.data as { codeSnippet?: string })?.codeSnippet ?? "",
			),
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
	const activeTheme = useTheme();
	const shikiTheme = useMemo(
		() => (activeTheme ? createShikiTheme(activeTheme) : undefined),
		[activeTheme],
	);

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [maxDepth, setMaxDepth] = useState(3);

	const buildGraphMutation =
		electronTrpc.referenceGraph.buildGraph.useMutation();
	const mutateAsyncRef = useRef(buildGraphMutation.mutateAsync);
	mutateAsyncRef.current = buildGraphMutation.mutateAsync;
	const requestGenerationRef = useRef(0);
	const [isExporting, setIsExporting] = useState(false);
	const { getNodes } = useReactFlow();

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

		const generation = ++requestGenerationRef.current;
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

			// Discard stale responses from earlier requests
			if (generation !== requestGenerationRef.current) return;

			const flowNodes: Node[] = graph.nodes.map((n) => ({
				id: n.id,
				type: "referenceNode",
				position: { x: 0, y: 0 },
				data: {
					...n,
					onDoubleClick: handleNodeDoubleClick,
					shikiTheme,
				},
			}));

			const flowEdges: Edge[] = graph.edges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				type: "smoothstep",
				animated: false,
			}));

			if (flowNodes.length > 0) {
				const layouted = await layoutGraph(flowNodes, flowEdges);
				if (generation !== requestGenerationRef.current) return;
				setNodes(layouted.nodes);
				setEdges(layouted.edges);
				setTimeout(() => fitView({ padding: 0.2 }), 50);
			} else {
				setNodes([]);
				setEdges([]);
				setError("No references found for this symbol.");
			}
		} catch (err) {
			if (generation !== requestGenerationRef.current) return;
			setError(
				err instanceof Error ? err.message : "Failed to build reference graph",
			);
		} finally {
			if (generation === requestGenerationRef.current) {
				setIsLoading(false);
			}
		}
	}, [
		refGraphState,
		workspaceId,
		maxDepth,
		handleNodeDoubleClick,
		shikiTheme,
		setNodes,
		setEdges,
		fitView,
	]);

	// Load graph on mount or when params change
	useEffect(() => {
		void loadGraph();
	}, [loadGraph]);

	const handleExportPng = useCallback(async () => {
		if (isExporting || nodes.length === 0) return;
		setIsExporting(true);

		try {
			const nodesList = getNodes();
			const nodesBounds = getNodesBounds(nodesList);
			const padding = 100;
			const imageWidth = nodesBounds.width + padding * 2;
			const imageHeight = nodesBounds.height + padding * 2;
			const viewport = getViewportForBounds(
				nodesBounds,
				imageWidth,
				imageHeight,
				0.5,
				2,
				0,
			);

			const viewportEl = document.querySelector(
				".react-flow__viewport",
			) as HTMLElement;
			if (!viewportEl) return;

			const controls = document.querySelector(
				".react-flow__controls",
			) as HTMLElement;
			const background = document.querySelector(
				".react-flow__background",
			) as HTMLElement;
			if (controls) controls.style.display = "none";
			if (background) background.style.display = "none";

			const dataUrl = await toPng(viewportEl, {
				backgroundColor: "transparent",
				width: imageWidth,
				height: imageHeight,
				style: {
					width: `${imageWidth}px`,
					height: `${imageHeight}px`,
					transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
				},
			});

			if (controls) controls.style.display = "";
			if (background) background.style.display = "";

			// Trigger download
			const link = document.createElement("a");
			link.download = `reference-graph-${Date.now()}.png`;
			link.href = dataUrl;
			link.click();
		} catch (err) {
			console.error("[reference-graph] Export PNG failed:", err);
		} finally {
			setIsExporting(false);
		}
	}, [isExporting, nodes.length, getNodes]);

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
							{refGraphState.absolutePath.split(/[\\/]/).pop()}:
							{refGraphState.line}
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
						<button
							type="button"
							onClick={() => void handleExportPng()}
							disabled={isExporting || nodes.length === 0}
							className="h-6 rounded border border-border bg-background px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
						>
							{isExporting ? "Exporting..." : "Export PNG"}
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
					<Background
						variant={BackgroundVariant.Dots}
						gap={20}
						size={1}
						bgColor="var(--sidebar)"
					/>
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
