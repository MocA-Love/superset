import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useResizeObserver from "use-resize-observer";
import { SpreadsheetDefaultAppButton } from "./components/SpreadsheetDefaultAppButton";
import {
	type ParsedCell,
	type RenderAnchor,
	type RichTextPart,
	useSpreadsheetData,
} from "./useSpreadsheetData";

/** EMU → px (96 DPI: 1px = 9525 EMU) */
const emuToPx = (emu: number): number => emu / 9525;

/** SVG stroke-dasharray from Excel dash style */
const SVG_DASH_PATTERNS: Record<string, string> = {
	solid: "",
	sysDot: "2,2",
	sysDash: "6,2",
	dash: "8,4",
	dashDot: "8,4,2,4",
	lgDash: "12,4",
	lgDashDot: "12,4,2,4",
	lgDashDotDot: "12,4,2,4,2,4",
};

function getDashPattern(dash: string): string {
	return SVG_DASH_PATTERNS[dash] || "";
}

interface SpreadsheetViewerProps {
	workspaceId: string;
	filePath: string;
	absoluteFilePath: string;
}

function RichTextContent({ parts }: { parts: RichTextPart[] }) {
	return (
		<>
			{parts.map((part, i) => {
				const key = `${i}-${part.text.slice(0, 8)}`;
				if (Object.keys(part.style).length === 0) {
					return <span key={key}>{part.text}</span>;
				}
				return (
					<span key={key} style={part.style}>
						{part.text}
					</span>
				);
			})}
		</>
	);
}

function CellContent({ cell }: { cell: ParsedCell }) {
	if (cell.richText) {
		return <RichTextContent parts={cell.richText} />;
	}
	return <>{cell.value}</>;
}

/** Render SVG diagonal lines inside a cell */
function DiagonalOverlay({
	diagonal,
}: {
	diagonal: NonNullable<ParsedCell["diagonal"]>;
}) {
	const widthMatch = diagonal.style.match(/^(\d+)px/);
	const strokeWidth = widthMatch ? Number(widthMatch[1]) : 1;

	return (
		<svg
			role="img"
			aria-label="Cell diagonal line"
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				pointerEvents: "none",
			}}
			preserveAspectRatio="none"
		>
			{diagonal.down && (
				<line
					x1="0"
					y1="0"
					x2="100%"
					y2="100%"
					stroke={diagonal.color}
					strokeWidth={strokeWidth}
					vectorEffect="non-scaling-stroke"
				/>
			)}
			{diagonal.up && (
				<line
					x1="0"
					y1="100%"
					x2="100%"
					y2="0"
					stroke={diagonal.color}
					strokeWidth={strokeWidth}
					vectorEffect="non-scaling-stroke"
				/>
			)}
		</svg>
	);
}

const ROW_NUM_COL_WIDTH = 36;
const DEFAULT_ROW_HEIGHT = 20;

export function SpreadsheetViewer({
	workspaceId,
	filePath,
	absoluteFilePath,
}: SpreadsheetViewerProps) {
	const { sheets, isLoading, error } = useSpreadsheetData(
		workspaceId,
		filePath,
	);
	const [activeSheetIndex, setActiveSheetIndex] = useState(0);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const tableRef = useRef<HTMLTableElement>(null);
	const [domRowYPositions, setDomRowYPositions] = useState<Map<
		number,
		number
	> | null>(null);

	const onResize = useCallback(({ width }: { width?: number }) => {
		if (width) setContainerWidth(width);
	}, []);

	const { ref: containerRef } = useResizeObserver({ onResize });

	const activeSheet = sheets[Math.min(activeSheetIndex, sheets.length - 1)];

	// Natural (unscaled) column widths from the parser
	const columnWidths = activeSheet?.columnWidths ?? [];

	// Cumulative column widths (unscaled) for shape x-coordinate calculation
	const cumulativeColWidths = useMemo(() => {
		const cumulative: number[] = [0];
		for (let i = 0; i < columnWidths.length; i++) {
			cumulative.push(cumulative[i] + columnWidths[i]);
		}
		return cumulative;
	}, [columnWidths]);

	// Natural table width (unscaled) = row-num col + all data columns
	const naturalTableWidth = useMemo(() => {
		return ROW_NUM_COL_WIDTH + columnWidths.reduce((sum, w) => sum + w, 0);
	}, [columnWidths]);

	// Scale factor: shrink table to fit container if needed.
	// Instead of recalculating individual column widths, use CSS transform
	// so the SVG overlay shares the exact same coordinate space as the table.
	const scaleFactor = useMemo(() => {
		if (!containerWidth || naturalTableWidth <= containerWidth) return 1;
		return containerWidth / naturalTableWidth;
	}, [containerWidth, naturalTableWidth]);

	// Measure actual row Y positions from the DOM after render.
	// Uses Excel row numbers (from data-row-num) as keys.
	useEffect(() => {
		if (!activeSheet || activeSheet.shapes.length === 0) {
			setDomRowYPositions(null);
			return;
		}

		const table = tableRef.current;
		if (!table) return;

		const rafId = requestAnimationFrame(() => {
			const rowMap = new Map<number, number>();
			const trs =
				table.querySelectorAll<HTMLTableRowElement>("tr[data-row-num]");
			for (const tr of trs) {
				const excelRow = Number.parseInt(tr.dataset.rowNum ?? "0", 10);
				rowMap.set(excelRow, tr.offsetTop);
			}
			if (trs.length > 0) {
				const lastTr = trs[trs.length - 1];
				const lastExcelRow = Number.parseInt(lastTr.dataset.rowNum ?? "0", 10);
				rowMap.set(lastExcelRow + 1, lastTr.offsetTop + lastTr.offsetHeight);
			}
			// Extrapolate for shapes extending beyond rendered rows
			let maxNeeded = 0;
			for (const s of activeSheet.shapes)
				maxNeeded = Math.max(maxNeeded, s.br.r + 2);
			const measuredKeys = Array.from(rowMap.keys());
			const measuredMax =
				measuredKeys.length > 0 ? Math.max(...measuredKeys) : 1;
			if (maxNeeded > measuredMax) {
				let cumulative = rowMap.get(measuredMax) ?? 0;
				for (let r = measuredMax; r <= maxNeeded; r++) {
					if (!rowMap.has(r)) rowMap.set(r, cumulative);
					cumulative += DEFAULT_ROW_HEIGHT;
				}
			}
			setDomRowYPositions(rowMap);
		});
		return () => cancelAnimationFrame(rafId);
	}, [activeSheet]);

	// Fallback cumulative row Y positions keyed by Excel row number
	const calculatedRowYPositions = useMemo(() => {
		if (!activeSheet) return new Map<number, number>();
		const map = new Map<number, number>();
		let cumY = 0;
		for (const row of activeSheet.rows) {
			map.set(row.excelRow, cumY);
			cumY += row.height;
		}
		const lastRow = activeSheet.rows[activeSheet.rows.length - 1];
		if (lastRow) map.set(lastRow.excelRow + 1, cumY);
		return map;
	}, [activeSheet]);

	const effectiveRowYPositions = domRowYPositions ?? calculatedRowYPositions;

	// Simple anchor position calculation — same approach as ai-zyusetu.
	// Because we use CSS transform: scale() instead of recalculating column
	// widths, the SVG and table share the same (unscaled) coordinate space.
	// EMU offsets are added directly without any scaling.
	const getAnchorPosition = useCallback(
		(anchor: RenderAnchor): { x: number; y: number } => {
			const minCol = activeSheet?.minCol ?? 1;
			const colIdx = Math.max(
				0,
				Math.min(anchor.c - (minCol - 1), cumulativeColWidths.length - 1),
			);
			const x =
				ROW_NUM_COL_WIDTH + cumulativeColWidths[colIdx] + emuToPx(anchor.co);
			const excelRow = anchor.r + 1;
			const y =
				(effectiveRowYPositions.get(excelRow) ?? 0) + emuToPx(anchor.ro);
			return { x, y };
		},
		[activeSheet, cumulativeColWidths, effectiveRowYPositions],
	);

	const renderShapeOverlay = useCallback(() => {
		if (!activeSheet || activeSheet.shapes.length === 0) return null;

		const shapes = activeSheet.shapes;
		const lastRow = activeSheet.rows[activeSheet.rows.length - 1];
		const totalHeight = lastRow
			? (effectiveRowYPositions.get(lastRow.excelRow + 1) ??
				activeSheet.rows.reduce((sum, r) => sum + r.height, 0))
			: 0;

		return (
			<svg
				role="img"
				aria-label="Drawing objects overlay"
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: naturalTableWidth,
					height: totalHeight,
					pointerEvents: "none",
					overflow: "hidden",
					zIndex: 10,
				}}
			>
				{shapes.map((shape, i) => {
					const tlPos = getAnchorPosition(shape.tl);
					const brPos = getAnchorPosition(shape.br);
					const dashPattern = getDashPattern(shape.o.d);
					const dashProps = dashPattern ? { strokeDasharray: dashPattern } : {};

					if (shape.t === "line") {
						const flipped = shape.vf !== shape.hf;
						return (
							<line
								key={`shape-${shape.n || i}`}
								x1={tlPos.x}
								y1={flipped ? brPos.y : tlPos.y}
								x2={brPos.x}
								y2={flipped ? tlPos.y : brPos.y}
								stroke={shape.o.cl}
								strokeWidth={shape.o.w}
								{...dashProps}
							/>
						);
					}

					return (
						<rect
							key={`shape-${shape.n || i}`}
							x={tlPos.x}
							y={tlPos.y}
							width={Math.max(0, brPos.x - tlPos.x)}
							height={Math.max(0, brPos.y - tlPos.y)}
							fill="none"
							stroke={shape.o.cl}
							strokeWidth={shape.o.w}
							{...dashProps}
						/>
					);
				})}
			</svg>
		);
	}, [
		activeSheet,
		naturalTableWidth,
		effectiveRowYPositions,
		getAnchorPosition,
	]);

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				Loading spreadsheet...
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

	if (sheets.length === 0 || !activeSheet) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				No sheets found
			</div>
		);
	}

	const needsScale = scaleFactor < 1;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-end border-b border-border bg-muted/20 px-3 py-2">
				<SpreadsheetDefaultAppButton absoluteFilePath={absoluteFilePath} />
			</div>
			<div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-white">
				{/* Outer wrapper: clips to container width */}
				<div
					style={{
						width: containerWidth ? `${containerWidth}px` : "100%",
						overflow: "hidden",
					}}
				>
					{/* Inner wrapper: holds table + SVG at natural size, scaled via CSS transform.
					    This ensures SVG and table share the exact same coordinate space. */}
					<div
						style={{
							position: "relative",
							width: `${naturalTableWidth}px`,
							...(needsScale && {
								transform: `scale(${scaleFactor})`,
								transformOrigin: "top left",
							}),
						}}
					>
						<table
							ref={tableRef}
							style={{
								borderCollapse: "collapse",
								tableLayout: "fixed",
								fontFamily:
									"'Calibri', 'MS PGothic', 'Meiryo', 'Segoe UI', sans-serif",
								fontSize: "11pt",
								color: "#000",
								width: `${naturalTableWidth}px`,
							}}
						>
							<colgroup>
								<col style={{ width: ROW_NUM_COL_WIDTH }} />
								{columnWidths.map((w, i) => (
									<col
										key={`col-${getColumnLabel(i)}`}
										style={{ width: w || undefined }}
									/>
								))}
							</colgroup>
							<thead style={{ position: "sticky", top: 0, zIndex: 20 }}>
								<tr>
									<th
										style={{
											border: "1px solid #c0c0c0",
											backgroundColor: "#f0f0f0",
											padding: "2px 4px",
											textAlign: "center",
											fontSize: "9px",
											fontWeight: "normal",
											color: "#666",
										}}
									/>
									{Array.from({ length: activeSheet.columnCount }, (_, i) => {
										const label = getColumnLabel(i);
										return (
											<th
												key={label}
												style={{
													border: "1px solid #c0c0c0",
													backgroundColor: "#f0f0f0",
													padding: "2px 4px",
													textAlign: "center",
													fontSize: "9px",
													fontWeight: "normal",
													color: "#666",
												}}
											>
												{label}
											</th>
										);
									})}
								</tr>
							</thead>
							<tbody>
								{activeSheet.rows.map((row, rowIdx) => (
									<tr
										key={`r${row.excelRow}`}
										data-row-num={row.excelRow}
										style={{ height: row.height }}
									>
										<td
											style={{
												border: "1px solid #c0c0c0",
												backgroundColor: "#f0f0f0",
												padding: "2px 4px",
												textAlign: "center",
												fontSize: "9px",
												fontWeight: "normal",
												color: "#666",
												userSelect: "none",
											}}
										>
											{rowIdx + 1}
										</td>
										{row.cells.map((cell, colIdx) => {
											if (cell.hidden) return null;

											const cellStyle: React.CSSProperties = {
												overflow: "hidden",
												padding: "1px 3px",
												whiteSpace: "nowrap",
												lineHeight: "normal",
												boxSizing: "border-box",
												position: cell.diagonal ? "relative" : undefined,
												...cell.style,
											};

											if (cell.wrapText) {
												cellStyle.whiteSpace = "pre-wrap";
												cellStyle.wordBreak = "break-all";
												cellStyle.overflow = "visible";
											}

											if (cell.verticalText) {
												cellStyle.writingMode = "vertical-rl";
												cellStyle.textOrientation = "upright";
												cellStyle.letterSpacing = 0;
												cellStyle.lineHeight = 1;
												cellStyle.textAlign = "center";
												cellStyle.verticalAlign = "middle";
												cellStyle.whiteSpace = "normal";
												cellStyle.wordBreak = "keep-all";
												cellStyle.overflow = "hidden";
												cellStyle.padding = "2px 0";
											}

											return (
												<td
													key={`${rowIdx + 1}-${getColumnLabel(colIdx)}`}
													style={cellStyle}
													colSpan={cell.colSpan}
													rowSpan={cell.rowSpan}
												>
													<CellContent cell={cell} />
													{cell.diagonal && (
														<DiagonalOverlay diagonal={cell.diagonal} />
													)}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
						{(domRowYPositions || activeSheet.shapes.length === 0) &&
							renderShapeOverlay()}
					</div>
				</div>
				{activeSheet.truncated && (
					<div
						style={{
							borderTop: "1px solid #c0c0c0",
							backgroundColor: "#f8f8f8",
							padding: "8px 12px",
							textAlign: "center",
							fontSize: "12px",
							color: "#888",
						}}
					>
						Showing first 2,000 rows. Full file contains more rows.
					</div>
				)}
			</div>

			{sheets.length > 1 && (
				<div className="flex gap-0 border-t border-border bg-muted/20">
					{sheets.map((sheet, idx) => (
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
