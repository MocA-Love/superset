import type { CommitGraphNode } from "shared/changes-types";
import { LANE_COLORS } from "../components/GitGraphView/constants";

export interface GraphEdge {
	fromLane: number;
	toLane: number;
	color: string;
}

export interface GraphNodeLayout {
	hash: string;
	lane: number;
	totalLanes: number;
	color: string;
	edges: GraphEdge[];
	passiveEdges: GraphEdge[];
	incomingLanes: number[];
	outgoingLanes: number[];
	hasIncomingLine: boolean;
}

export function computeGraphLanes(nodes: CommitGraphNode[]): GraphNodeLayout[] {
	const getColor = (lane: number) =>
		LANE_COLORS[lane % LANE_COLORS.length] ?? LANE_COLORS[0];
	let activeLanes: string[] = [];
	const layouts: GraphNodeLayout[] = [];

	for (const node of nodes) {
		const incomingLaneHashes = [...activeLanes];
		const existingLane = incomingLaneHashes.indexOf(node.hash);
		let lane = existingLane;
		if (lane === -1) {
			lane = incomingLaneHashes.length;
			activeLanes = [...incomingLaneHashes, node.hash];
		}

		const incomingLanes = incomingLaneHashes.map((_, index) => index);
		const nextLanes = [...activeLanes];
		const color = getColor(lane);
		const edges: GraphEdge[] = [];
		const passiveEdges: GraphEdge[] = [];
		const [firstParent, ...mergeParents] = node.parentHashes;

		if (!firstParent) {
			nextLanes.splice(lane, 1);
		} else {
			const existingFirstParentLane = nextLanes.indexOf(firstParent);
			if (existingFirstParentLane === -1 || existingFirstParentLane === lane) {
				nextLanes[lane] = firstParent;
				edges.push({ fromLane: lane, toLane: lane, color });
			} else {
				nextLanes.splice(lane, 1);
				const targetLane =
					existingFirstParentLane > lane
						? existingFirstParentLane - 1
						: existingFirstParentLane;
				edges.push({
					fromLane: lane,
					toLane: targetLane,
					color: getColor(targetLane),
				});
			}
		}

		let insertLane = Math.min(lane + 1, nextLanes.length);
		for (const parentHash of mergeParents) {
			const existingParentLane = nextLanes.indexOf(parentHash);
			if (existingParentLane !== -1) {
				edges.push({
					fromLane: lane,
					toLane: existingParentLane,
					color: getColor(existingParentLane),
				});
				insertLane = Math.max(insertLane, existingParentLane + 1);
				continue;
			}

			const targetLane = Math.min(insertLane, nextLanes.length);
			nextLanes.splice(targetLane, 0, parentHash);
			edges.push({
				fromLane: lane,
				toLane: targetLane,
				color: getColor(targetLane),
			});
			insertLane = targetLane + 1;
		}

		for (const [incomingLane, hash] of incomingLaneHashes.entries()) {
			if (hash === node.hash) {
				continue;
			}

			const outgoingLane = nextLanes.indexOf(hash);
			if (outgoingLane === -1) {
				continue;
			}

			passiveEdges.push({
				fromLane: incomingLane,
				toLane: outgoingLane,
				color: getColor(outgoingLane),
			});
		}

		const outgoingLanes = nextLanes.map((_, index) => index);
		const maxTargetLane = [...edges, ...passiveEdges].reduce(
			(maxLane, edge) => Math.max(maxLane, edge.fromLane + 1, edge.toLane + 1),
			0,
		);
		const totalLanes = Math.max(
			1,
			incomingLanes.length,
			outgoingLanes.length,
			lane + 1,
			maxTargetLane,
		);

		layouts.push({
			hash: node.hash,
			lane,
			totalLanes,
			color,
			edges,
			passiveEdges,
			incomingLanes,
			outgoingLanes,
			hasIncomingLine: existingLane !== -1,
		});
		activeLanes = nextLanes;
	}

	return layouts;
}
