import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import type { ChangeCategory } from "shared/changes-types";
import useResizeObserver from "use-resize-observer";
import type { ParsedCell, RichTextPart } from "./parseWorkbook";
import {
	type DiffParsedRow,
	type DiffSegment,
	useSpreadsheetDiff,
} from "./useSpreadsheetDiff";

interface SpreadsheetDiffViewerProps {
	workspaceId: string;
	worktreePath: string;
	filePath: string;
	diffCategory?: ChangeCategory;
	commitHash?: string;
}

const ROW_NUM_COL_WIDTH = 30;

const DIFF_BG = {
	added: "rgba(34, 197, 94, 0.25)",
	removed: "rgba(239, 68, 68, 0.25)",
	modified: "rgba(59, 130, 246, 0.2)",
} as const;

const DIFF_BORDER = {
	added: "2px solid #22c55e",
	removed: "2px solid #ef4444",
	modified: "2px solid #3b82f6",
} as const;

function RichTextContent({ parts }: { parts: RichTextPart[] }) {
	return (
		<>
			{parts.map((part, i) => {
				const key = `${i}-${part.text.slice(0, 8)}`;
				return Object.keys(part.style).length === 0 ? (
					<span key={key}>{part.text}</span>
				) : (
					<span key={key} style={part.style}>
						{part.text}
					</span>
				);
			})}
		</>
	);
}

function CellContent({ cell }: { cell: ParsedCell }) {
	if (cell.richText) return <RichTextContent parts={cell.richText} />;
	return <>{cell.value}</>;
}

function InlineDiffContent({ segments }: { segments: DiffSegment[] }) {
	return (
		<>
			{segments.map((seg, i) => {
				const key = `${i}-${seg.type}-${seg.text.slice(0, 8)}`;
				switch (seg.type) {
					case "added":
						return (
							<span
								key={key}
								style={{
									backgroundColor: "rgba(34, 197, 94, 0.35)",
									borderRadius: 2,
								}}
							>
								{seg.text}
							</span>
						);
					case "removed":
						return (
							<span
								key={key}
								style={{
									backgroundColor: "rgba(239, 68, 68, 0.3)",
									textDecoration: "line-through",
									borderRadius: 2,
								}}
							>
								{seg.text}
							</span>
						);
					default:
						return <span key={key}>{seg.text}</span>;
				}
			})}
		</>
	);
}

function DiffTable({
	rows,
	columnWidths,
	label,
	scrollRef,
	peerScrollRef,
}: {
	rows: DiffParsedRow[];
	columnWidths: number[];
	label: string;
	scrollRef: RefObject<HTMLDivElement | null>;
	peerScrollRef: RefObject<HTMLDivElement | null>;
}) {
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const isSyncingRef = useRef(false);

	const onResize = useCallback(({ width }: { width?: number }) => {
		if (width) setContainerWidth(width);
	}, []);
	const { ref: sizeRef } = useResizeObserver({ onResize });

	const scaledWidths = useMemo(() => {
		if (!containerWidth) return columnWidths;
		const total = ROW_NUM_COL_WIDTH + columnWidths.reduce((s, w) => s + w, 0);
		if (total <= containerWidth) return columnWidths;
		const available = containerWidth - ROW_NUM_COL_WIDTH;
		const colTotal = columnWidths.reduce((s, w) => s + w, 0);
		if (colTotal <= 0) return columnWidths;
		return columnWidths.map((w) => Math.floor((w / colTotal) * available));
	}, [columnWidths, containerWidth]);

	const handleScroll = useCallback(() => {
		if (isSyncingRef.current) {
			isSyncingRef.current = false;
			return;
		}
		const el = scrollRef.current;
		const peer = peerScrollRef.current;
		if (!el || !peer) return;
		isSyncingRef.current = true;
		peer.scrollTop = el.scrollTop;
		peer.scrollLeft = el.scrollLeft;
	}, [scrollRef, peerScrollRef]);

	const setRefs = useCallback(
		(node: HTMLDivElement | null) => {
			(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
				node;
			if (typeof sizeRef === "function") sizeRef(node);
		},
		[scrollRef, sizeRef],
	);

	return (
		<div
			ref={setRefs}
			className="min-h-0 flex-1 overflow-auto bg-white"
			onScroll={handleScroll}
		>
			<div
				style={{
					padding: "4px 8px",
					fontSize: "11px",
					fontWeight: 500,
					color: "#666",
					borderBottom: "1px solid #e0e0e0",
					backgroundColor: "#fafafa",
					position: "sticky",
					top: 0,
					zIndex: 11,
				}}
			>
				{label}
			</div>
			<table
				style={{
					borderCollapse: "collapse",
					tableLayout: "fixed",
					fontFamily:
						"'Calibri', 'MS PGothic', 'Meiryo', 'Segoe UI', sans-serif",
					fontSize: "10pt",
					color: "#000",
					width: containerWidth ? `${containerWidth}px` : "100%",
				}}
			>
				<colgroup>
					<col style={{ width: ROW_NUM_COL_WIDTH }} />
					{scaledWidths.map((w, i) => (
						<col
							key={`col-${getColumnLabel(i)}`}
							style={{ width: w || undefined }}
						/>
					))}
				</colgroup>
				<tbody>
					{rows.map((row, rowIdx) => (
						<tr key={`r${rowIdx + 1}`} style={{ height: row.height }}>
							<td
								style={{
									border: "1px solid #d0d0d0",
									backgroundColor: "#f5f5f5",
									padding: "1px 3px",
									textAlign: "center",
									fontSize: "8px",
									color: "#999",
									userSelect: "none",
								}}
							>
								{rowIdx + 1}
							</td>
							{row.cells.map((cell, colIdx) => {
								if (cell.hidden) return null;
								const cellStyle: React.CSSProperties = {
									overflow: "hidden",
									padding: "1px 2px",
									whiteSpace: "nowrap",
									lineHeight: "normal",
									boxSizing: "border-box",
									...cell.style,
								};
								if (cell.diffStatus) {
									cellStyle.backgroundColor = DIFF_BG[cell.diffStatus];
									cellStyle.outline = DIFF_BORDER[cell.diffStatus];
									cellStyle.outlineOffset = "-2px";
								}
								if (cell.wrapText) {
									cellStyle.whiteSpace = "pre-wrap";
									cellStyle.wordBreak = "break-all";
								}

								return (
									<td
										key={`${rowIdx + 1}-${getColumnLabel(colIdx)}`}
										style={cellStyle}
										colSpan={cell.colSpan}
										rowSpan={cell.rowSpan}
									>
										{cell.diffSegments ? (
											<InlineDiffContent segments={cell.diffSegments} />
										) : (
											<CellContent cell={cell} />
										)}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function SpreadsheetDiffViewer({
	workspaceId,
	worktreePath,
	filePath,
	diffCategory,
	commitHash,
}: SpreadsheetDiffViewerProps) {
	const { diffSheets, isLoading, error } = useSpreadsheetDiff({
		workspaceId,
		worktreePath,
		filePath,
		diffCategory,
		commitHash,
	});
	const leftScrollRef = useRef<HTMLDivElement>(null);
	const rightScrollRef = useRef<HTMLDivElement>(null);
	const [activeSheetIndex, setActiveSheetIndex] = useState(0);

	const activeSheet =
		diffSheets.length > 0
			? diffSheets[Math.min(activeSheetIndex, diffSheets.length - 1)]
			: null;

	const diffRowIndices = useMemo(() => {
		if (!activeSheet) return [];
		const indices: number[] = [];
		for (let r = 0; r < activeSheet.modifiedRows.length; r++) {
			if (activeSheet.modifiedRows[r].cells.some((c) => c.diffStatus)) {
				indices.push(r);
			}
		}
		return indices;
	}, [activeSheet]);

	const [currentDiffIdx, setCurrentDiffIdx] = useState(0);

	const jumpToDiff = useCallback(
		(idx: number) => {
			const rowIdx = diffRowIndices[idx];
			if (rowIdx === undefined) return;
			setCurrentDiffIdx(idx);
			const left = leftScrollRef.current;
			const right = rightScrollRef.current;
			if (!left) return;
			const rows = left.querySelectorAll("tbody tr");
			const target = rows[rowIdx] as HTMLElement | undefined;
			if (!target) return;
			const containerRect = left.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			const scrollTop =
				left.scrollTop +
				targetRect.top -
				containerRect.top -
				containerRect.height / 2 +
				targetRect.height / 2;
			left.scrollTop = scrollTop;
			if (right) right.scrollTop = scrollTop;
		},
		[diffRowIndices],
	);

	const goNext = useCallback(() => {
		if (diffRowIndices.length === 0) return;
		const next =
			currentDiffIdx + 1 < diffRowIndices.length ? currentDiffIdx + 1 : 0;
		jumpToDiff(next);
	}, [currentDiffIdx, diffRowIndices, jumpToDiff]);

	const goPrev = useCallback(() => {
		if (diffRowIndices.length === 0) return;
		const prev =
			currentDiffIdx - 1 >= 0 ? currentDiffIdx - 1 : diffRowIndices.length - 1;
		jumpToDiff(prev);
	}, [currentDiffIdx, diffRowIndices, jumpToDiff]);

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				Loading diff...
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				{error}
			</div>
		);
	}

	if (!activeSheet) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				No changes found
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div
				style={{
					padding: "4px 12px",
					fontSize: "12px",
					backgroundColor: "#1e1e2e",
					color: "#cdd6f4",
					borderBottom: "1px solid #333",
					flexShrink: 0,
					display: "flex",
					alignItems: "center",
					justifyContent: "flex-end",
					gap: 12,
				}}
			>
				<span style={{ color: "#a6adc8" }}>
					{diffRowIndices.length > 0
						? `${diffRowIndices.length} changes`
						: "No changes"}
				</span>
				{diffRowIndices.length > 0 && (
					<>
						<button
							type="button"
							onClick={goPrev}
							style={{
								background: "#313244",
								border: "1px solid #45475a",
								borderRadius: 4,
								color: "#cdd6f4",
								padding: "2px 10px",
								cursor: "pointer",
								fontSize: "11px",
							}}
						>
							Prev
						</button>
						<span style={{ fontSize: "11px", color: "#a6adc8" }}>
							{currentDiffIdx + 1} / {diffRowIndices.length}
						</span>
						<button
							type="button"
							onClick={goNext}
							style={{
								background: "#313244",
								border: "1px solid #45475a",
								borderRadius: 4,
								color: "#cdd6f4",
								padding: "2px 10px",
								cursor: "pointer",
								fontSize: "11px",
							}}
						>
							Next
						</button>
					</>
				)}
			</div>
			<div className="flex min-h-0 flex-1">
				<DiffTable
					rows={activeSheet.originalRows}
					columnWidths={activeSheet.columnWidths}
					label="Original (HEAD)"
					scrollRef={leftScrollRef}
					peerScrollRef={rightScrollRef}
				/>
				<div style={{ width: 1, backgroundColor: "#d0d0d0", flexShrink: 0 }} />
				<DiffTable
					rows={activeSheet.modifiedRows}
					columnWidths={activeSheet.columnWidths}
					label="Modified (Working Copy)"
					scrollRef={rightScrollRef}
					peerScrollRef={leftScrollRef}
				/>
			</div>

			{diffSheets.length > 1 && (
				<div className="flex gap-0 border-t border-border bg-muted/20">
					{diffSheets.map((sheet, idx) => (
						<button
							key={sheet.name}
							type="button"
							className={`border-r border-border px-3 py-1.5 text-xs transition-colors ${
								idx === activeSheetIndex
									? "bg-background text-foreground font-medium"
									: "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
							}`}
							onClick={() => setActiveSheetIndex(idx)}
						>
							{sheet.name}
							{sheet.sheetStatus === "added" && " (+)"}
							{sheet.sheetStatus === "removed" && " (-)"}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function getColumnLabel(index: number): string {
	let label = "";
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}
