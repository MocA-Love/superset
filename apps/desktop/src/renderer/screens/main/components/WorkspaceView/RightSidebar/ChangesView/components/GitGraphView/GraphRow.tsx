import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import type { CommitGraphNode } from "shared/changes-types";
import type { GraphEdge, GraphNodeLayout } from "../../utils/computeGraphLanes";
import { CommitDetailsPanel } from "./CommitDetailsPanel/index";
import {
	GRAPH_PADDING_X,
	GRAPH_STROKE_WIDTH,
	LANE_WIDTH,
	NODE_RADIUS,
	ROW_HEIGHT,
} from "./constants";

interface GraphRowProps {
	node: CommitGraphNode;
	layout: GraphNodeLayout;
	graphWidth: number;
	commitInfoGridTemplate: string;
	worktreePath: string;
	workspaceId: string;
	isExpanded: boolean;
	onToggle: () => void;
	onParentSelect: (hash: string) => void;
	registerRowRef: (hash: string, node: HTMLDivElement | null) => void;
	visibleCommitHashes: Set<string>;
	containerWidth: number;
}

function laneX(lane: number): number {
	return GRAPH_PADDING_X + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function formatRefLabel(ref: string): string {
	return ref.replace(/^HEAD -> /, "").trim();
}

export function GraphRow({
	node,
	layout,
	graphWidth,
	commitInfoGridTemplate,
	worktreePath,
	workspaceId,
	isExpanded,
	onToggle,
	onParentSelect,
	registerRowRef,
	visibleCommitHashes,
	containerWidth,
}: GraphRowProps) {
	const cx = laneX(layout.lane);
	const cy = ROW_HEIGHT / 2;

	const formattedDate = new Date(node.date).toLocaleDateString("ja-JP", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	const continuationLines = layout.passiveEdges.map((edge) => {
		const x1 = laneX(edge.fromLane);
		const x2 = laneX(edge.toLane);
		const edgeKey = `${node.hash}-passive-${edge.fromLane}-${edge.toLane}-${edge.color}`;

		if (x1 === x2) {
			return (
				<line
					key={edgeKey}
					x1={x1}
					y1={0}
					x2={x2}
					y2={ROW_HEIGHT}
					stroke={edge.color}
					strokeWidth={GRAPH_STROKE_WIDTH}
					opacity={0.45}
				/>
			);
		}

		const controlY = ROW_HEIGHT * 0.5;
		return (
			<path
				key={edgeKey}
				d={`M ${x1} 0 C ${x1} ${controlY}, ${x2} ${controlY}, ${x2} ${ROW_HEIGHT}`}
				stroke={edge.color}
				strokeWidth={GRAPH_STROKE_WIDTH}
				opacity={0.45}
				fill="none"
			/>
		);
	});

	const edgeLines = layout.edges.map((edge: GraphEdge) => {
		const x1 = cx;
		const y1 = cy;
		const x2 = laneX(edge.toLane);
		const y2 = ROW_HEIGHT;
		const edgeKey = `${node.hash}-edge-${edge.fromLane}-${edge.toLane}-${edge.color}`;

		if (x1 === x2) {
			// Straight down
			return (
				<line
					key={edgeKey}
					x1={x1}
					y1={y1}
					x2={x2}
					y2={y2}
					stroke={edge.color}
					strokeWidth={GRAPH_STROKE_WIDTH}
				/>
			);
		}

		const controlY = y1 + (y2 - y1) * 0.45;
		return (
			<path
				key={edgeKey}
				d={`M ${x1} ${y1} C ${x1} ${controlY}, ${x2} ${controlY}, ${x2} ${y2}`}
				stroke={edge.color}
				strokeWidth={GRAPH_STROKE_WIDTH}
				fill="none"
			/>
		);
	});

	const branchRefs = node.refs.filter(
		(ref) => !ref.startsWith("tag:") && ref !== "",
	);
	const visibleRefs = branchRefs.slice(0, 2).map(formatRefLabel);
	const hiddenRefCount = Math.max(0, branchRefs.length - visibleRefs.length);

	return (
		<div
			ref={(element) => registerRowRef(node.hash, element)}
			className="border-b border-border/40 overflow-hidden"
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={isExpanded}
				className={`grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-2 text-left transition-colors hover:bg-muted/30 ${
					isExpanded ? "bg-muted/30" : ""
				}`}
				style={{ height: ROW_HEIGHT }}
			>
				<svg
					width={graphWidth}
					height={ROW_HEIGHT}
					viewBox={`0 0 ${graphWidth} ${ROW_HEIGHT}`}
					className="block shrink-0"
					aria-hidden="true"
					focusable="false"
				>
					{continuationLines}
					{layout.hasIncomingLine && (
						<line
							x1={cx}
							y1={0}
							x2={cx}
							y2={cy}
							stroke={layout.color}
							strokeWidth={GRAPH_STROKE_WIDTH}
						/>
					)}
					{edgeLines}
					<circle
						cx={cx}
						cy={cy}
						r={NODE_RADIUS}
						fill={layout.color}
						stroke="var(--background)"
						strokeWidth={1.25}
					/>
				</svg>

				<div
					className="grid min-w-0 items-center gap-x-3"
					style={{ gridTemplateColumns: commitInfoGridTemplate }}
				>
					<span
						className="truncate font-mono text-[11px] text-muted-foreground/70"
						title={node.hash}
					>
						{node.shortHash}
					</span>

					<div className="flex min-w-0 items-center gap-1 overflow-hidden">
						{visibleRefs.map((ref) => (
							<Tooltip key={ref}>
								<TooltipTrigger asChild>
									<span
										className="truncate rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none"
										style={{
											borderColor: `${layout.color}55`,
											background: `${layout.color}1f`,
											color: layout.color,
										}}
									>
										{ref}
									</span>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									{ref}
								</TooltipContent>
							</Tooltip>
						))}
						{hiddenRefCount > 0 && (
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="shrink-0 cursor-default rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
										+{hiddenRefCount}
									</span>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									{branchRefs.slice(2).map(formatRefLabel).join(", ")}
								</TooltipContent>
							</Tooltip>
						)}
					</div>

					<span
						className="truncate text-[12px] text-foreground/85"
						title={node.message}
					>
						{node.message || "(no message)"}
					</span>

					<span
						className="truncate text-muted-foreground/70"
						title={node.author}
					>
						{node.author}
					</span>

					<span className="truncate text-right text-muted-foreground/60">
						{formattedDate}
					</span>
				</div>
			</button>

			{isExpanded && (
				<div
					className="animate-in slide-in-from-top-2 overflow-hidden duration-200"
					style={containerWidth > 0 ? { maxWidth: containerWidth } : undefined}
				>
					<CommitDetailsPanel
						node={node}
						worktreePath={worktreePath}
						workspaceId={workspaceId}
						onParentSelect={onParentSelect}
						visibleCommitHashes={visibleCommitHashes}
						containerWidth={containerWidth}
					/>
				</div>
			)}
		</div>
	);
}
