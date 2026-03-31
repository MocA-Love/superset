import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { computeGraphLanes } from "../../utils/computeGraphLanes";
import {
	buildCommitInfoGridTemplate,
	DEFAULT_COLUMN_WIDTHS,
	GRAPH_MIN_WIDTH,
	GRAPH_PADDING_X,
	LANE_WIDTH,
	MIN_COLUMN_WIDTHS,
} from "./constants";
import { GraphRow } from "./GraphRow";

interface GitGraphViewProps {
	worktreePath: string;
	workspaceId: string;
}

const HEADER_COLUMNS = [
	{ label: "Hash", align: "left" },
	{ label: "Branch", align: "left" },
	{ label: "Message", align: "left" },
	{ label: "Author", align: "left" },
	{ label: "Date", align: "right" },
] as const;

const COMMIT_INFO_GRID_GAP = 12;
const COMMIT_INFO_SECTION_GAP = 12;
const CONTENT_HORIZONTAL_PADDING = 16;

export function GitGraphView({ worktreePath, workspaceId }: GitGraphViewProps) {
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
		null,
	);
	const [columnWidths, setColumnWidths] = useState<number[]>([
		...DEFAULT_COLUMN_WIDTHS,
	]);
	const rowRefs = useRef(new Map<string, HTMLDivElement>());
	const columnWidthsRef = useRef(columnWidths);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const { data, isLoading, isError } =
		electronTrpc.changes.getCommitGraph.useQuery(
			{ worktreePath },
			{ enabled: !!worktreePath, staleTime: 5_000 },
		);

	const { nodes, layouts } = useMemo(() => {
		const nodes = data?.nodes ?? [];
		const layouts = computeGraphLanes(nodes);
		return { nodes, layouts };
	}, [data]);
	const visibleCommitHashes = useMemo(
		() => new Set(nodes.map((node) => node.hash)),
		[nodes],
	);

	const maxLanes = useMemo(
		() => Math.max(1, ...layouts.map((l) => l.totalLanes)),
		[layouts],
	);
	const graphWidth = Math.max(
		GRAPH_MIN_WIDTH,
		maxLanes * LANE_WIDTH + GRAPH_PADDING_X * 2,
	);
	const commitInfoGridTemplate = useMemo(
		() => buildCommitInfoGridTemplate(columnWidths),
		[columnWidths],
	);
	const minContentWidth = useMemo(() => {
		const infoMinWidth =
			columnWidths.reduce((sum, width) => sum + width, 0) +
			COMMIT_INFO_GRID_GAP * (columnWidths.length - 1);

		return (
			graphWidth +
			infoMinWidth +
			COMMIT_INFO_SECTION_GAP +
			CONTENT_HORIZONTAL_PADDING
		);
	}, [columnWidths, graphWidth]);

	useEffect(() => {
		if (selectedCommitHash && !visibleCommitHashes.has(selectedCommitHash)) {
			setSelectedCommitHash(null);
		}
	}, [selectedCommitHash, visibleCommitHashes]);

	useEffect(() => {
		columnWidthsRef.current = columnWidths;
	}, [columnWidths]);

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			setContainerWidth(el.clientWidth);
		});
		observer.observe(el);
		setContainerWidth(el.clientWidth);
		return () => observer.disconnect();
	}, []);

	const handleRowToggle = useCallback((hash: string) => {
		setSelectedCommitHash((current) => (current === hash ? null : hash));
	}, []);

	const handleParentSelect = useCallback(
		(hash: string) => {
			if (!visibleCommitHashes.has(hash)) {
				return;
			}

			setSelectedCommitHash(hash);
			rowRefs.current.get(hash)?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			});
		},
		[visibleCommitHashes],
	);

	const registerRowRef = useCallback(
		(hash: string, node: HTMLDivElement | null) => {
			if (node) {
				rowRefs.current.set(hash, node);
				return;
			}

			rowRefs.current.delete(hash);
		},
		[],
	);

	const handleResizeStart = useCallback((index: number, clientX: number) => {
		const startWidth = columnWidthsRef.current[index];
		const startX = clientX;

		const handleMouseMove = (event: MouseEvent) => {
			const nextWidth = Math.max(
				MIN_COLUMN_WIDTHS[index],
				startWidth + event.clientX - startX,
			);

			setColumnWidths((currentWidths) => {
				if (currentWidths[index] === nextWidth) {
					return currentWidths;
				}

				return currentWidths.map((width, currentIndex) =>
					currentIndex === index ? nextWidth : width,
				);
			});
		};

		const handleMouseUp = () => {
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			window.removeEventListener("blur", handleMouseUp);
		};

		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		window.addEventListener("blur", handleMouseUp);
	}, []);

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
				Loading graph...
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex h-full items-center justify-center text-xs text-destructive">
				Failed to load git graph
			</div>
		);
	}

	if (nodes.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
				No commits
			</div>
		);
	}

	return (
		<div ref={scrollContainerRef} className="h-full overflow-auto text-xs">
			<div className="min-h-full" style={{ minWidth: minContentWidth }}>
				<div className="sticky top-0 z-10 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-border/70 bg-background/95 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70 backdrop-blur">
					<div className="shrink-0 text-center" style={{ width: graphWidth }}>
						Graph
					</div>
					<div
						className="grid min-w-0 items-center gap-x-3"
						style={{ gridTemplateColumns: commitInfoGridTemplate }}
					>
						{HEADER_COLUMNS.map((column, index) => (
							<div
								key={column.label}
								className={`relative min-w-0 ${
									column.align === "right" ? "text-right" : ""
								}`}
							>
								<span className="font-medium">{column.label}</span>
								<button
									type="button"
									aria-label={`Resize ${column.label} column`}
									className="absolute right-[-6px] top-1/2 h-6 w-3 -translate-y-1/2 cursor-col-resize select-none touch-none after:absolute after:inset-x-1.5 after:top-0 after:h-full after:rounded-full after:bg-border/70 after:content-[''] hover:after:bg-foreground/20"
									onMouseDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
										handleResizeStart(index, event.clientX);
									}}
									onClick={(event) => event.preventDefault()}
								/>
							</div>
						))}
					</div>
				</div>

				<div className="py-1">
					{nodes.map((node, i) => (
						<GraphRow
							key={node.hash}
							node={node}
							layout={layouts[i]}
							graphWidth={graphWidth}
							commitInfoGridTemplate={commitInfoGridTemplate}
							worktreePath={worktreePath}
							workspaceId={workspaceId}
							isExpanded={selectedCommitHash === node.hash}
							onToggle={() => handleRowToggle(node.hash)}
							onParentSelect={handleParentSelect}
							registerRowRef={registerRowRef}
							visibleCommitHashes={visibleCommitHashes}
							containerWidth={containerWidth}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
