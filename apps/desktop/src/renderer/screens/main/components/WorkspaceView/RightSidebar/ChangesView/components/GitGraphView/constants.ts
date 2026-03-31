export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 28;
export const NODE_RADIUS = 4;
export const GRAPH_MIN_WIDTH = 72;
export const GRAPH_PADDING_X = 8;
export const GRAPH_STROKE_WIDTH = 1.5;
export const DEFAULT_COLUMN_WIDTHS = [72, 200, 550, 120, 90] as const;
export const MIN_COLUMN_WIDTHS = [60, 80, 100, 60, 80] as const;

export function buildCommitInfoGridTemplate(columnWidths: readonly number[]) {
	const [hashWidth, branchWidth, messageWidth, authorWidth, dateWidth] =
		columnWidths;

	return `${hashWidth}px ${branchWidth}px ${messageWidth}px ${authorWidth}px ${dateWidth}px`;
}

export const LANE_COLORS = [
	"#6366f1",
	"#22c55e",
	"#f59e0b",
	"#ef4444",
	"#3b82f6",
	"#a855f7",
	"#14b8a6",
	"#f97316",
	"#ec4899",
	"#84cc16",
];
