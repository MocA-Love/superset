import { useCallback, useMemo, useState } from "react";
import useResizeObserver from "use-resize-observer";
import {
	type ParsedCell,
	type RichTextPart,
	useSpreadsheetData,
} from "./useSpreadsheetData";

interface SpreadsheetViewerProps {
	workspaceId: string;
	filePath: string;
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

const ROW_NUM_COL_WIDTH = 36;

export function SpreadsheetViewer({
	workspaceId,
	filePath,
}: SpreadsheetViewerProps) {
	const { sheets, isLoading, error } = useSpreadsheetData(
		workspaceId,
		filePath,
	);
	const [activeSheetIndex, setActiveSheetIndex] = useState(0);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);

	const onResize = useCallback(({ width }: { width?: number }) => {
		if (width) setContainerWidth(width);
	}, []);

	const { ref: containerRef } = useResizeObserver({ onResize });

	const activeSheet = sheets[Math.min(activeSheetIndex, sheets.length - 1)];

	const scaledColumnWidths = useMemo(() => {
		if (!activeSheet) return [];
		const widths = activeSheet.columnWidths;
		if (!containerWidth) return widths;

		const totalNatural =
			ROW_NUM_COL_WIDTH + widths.reduce((sum, w) => sum + w, 0);
		if (totalNatural <= containerWidth) return widths;

		const availableForCols = containerWidth - ROW_NUM_COL_WIDTH;
		const colTotal = widths.reduce((sum, w) => sum + w, 0);
		if (colTotal <= 0) return widths;

		return widths.map((w) => Math.floor((w / colTotal) * availableForCols));
	}, [activeSheet, containerWidth]);

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

	return (
		<div className="flex h-full flex-col">
			<div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-white">
				<table
					style={{
						borderCollapse: "collapse",
						tableLayout: "fixed",
						fontFamily:
							"'Calibri', 'MS PGothic', 'Meiryo', 'Segoe UI', sans-serif",
						fontSize: "11pt",
						color: "#000",
						width: containerWidth ? `${containerWidth}px` : "100%",
					}}
				>
					<colgroup>
						<col style={{ width: ROW_NUM_COL_WIDTH }} />
						{scaledColumnWidths.map((w, i) => (
							<col
								key={`col-${getColumnLabel(i)}`}
								style={{ width: w || undefined }}
							/>
						))}
					</colgroup>
					<thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
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
							<tr key={`r${rowIdx + 1}`} style={{ height: row.height }}>
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
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
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
