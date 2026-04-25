import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { ChangeCategory } from "shared/changes-types";
import useResizeObserver from "use-resize-observer";
import { SpreadsheetDefaultAppButton } from "./components/SpreadsheetDefaultAppButton";
import type { ParsedCell, RichTextPart } from "./parseWorkbook";
import {
	type DiffParsedCell,
	type DiffParsedRow,
	type DiffParsedSheet,
	type DiffSegment,
	useSpreadsheetDiff,
} from "./useSpreadsheetDiff";

interface SpreadsheetDiffViewerProps {
	workspaceId: string;
	worktreePath: string;
	filePath: string;
	absoluteFilePath: string;
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

function DiffCellTooltip({
	segments,
	anchorEl,
}: {
	segments: DiffSegment[];
	anchorEl: HTMLElement;
}) {
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const tooltipRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const rect = anchorEl.getBoundingClientRect();
		const top = rect.top - 6;
		const left = Math.min(rect.left, window.innerWidth - 500);
		setPos({ top, left: Math.max(4, left) });
	}, [anchorEl]);

	return createPortal(
		<div
			ref={tooltipRef}
			style={{
				position: "fixed",
				left: pos.left,
				top: pos.top,
				transform: "translateY(-100%)",
				maxWidth: 640,
				minWidth: 160,
				padding: "8px 12px",
				backgroundColor: "#1e1e2e",
				color: "#cdd6f4",
				borderRadius: 8,
				boxShadow: "0 4px 24px rgba(0,0,0,0.28)",
				fontSize: "13px",
				lineHeight: 1.7,
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				zIndex: 9999,
				pointerEvents: "none",
				border: "1px solid rgba(255,255,255,0.08)",
			}}
		>
			<InlineDiffContent segments={segments} />
		</div>,
		document.body,
	);
}

interface DiffCellProps {
	cell: DiffParsedCell;
	cellKey: string;
}

interface DiffLocation {
	sheetIndex: number;
	rowIndex: number;
}

function DiffCell({ cell, cellKey }: DiffCellProps) {
	const [hovered, setHovered] = useState(false);
	const tdRef = useRef<HTMLTableCellElement>(null);

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
	if (cell.diffSegments) {
		cellStyle.cursor = "default";
	}

	return (
		<td
			ref={tdRef}
			key={cellKey}
			style={cellStyle}
			colSpan={cell.colSpan}
			rowSpan={cell.rowSpan}
			onMouseEnter={cell.diffSegments ? () => setHovered(true) : undefined}
			onMouseLeave={cell.diffSegments ? () => setHovered(false) : undefined}
		>
			{cell.diffSegments ? (
				<InlineDiffContent segments={cell.diffSegments} />
			) : (
				<CellContent cell={cell} />
			)}
			{hovered && cell.diffSegments && tdRef.current && (
				<DiffCellTooltip
					segments={cell.diffSegments}
					anchorEl={tdRef.current}
				/>
			)}
		</td>
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
			className="min-h-0 flex-1 overflow-auto bg-background-solid"
			onScroll={handleScroll}
		>
			<div
				style={{
					padding: "4px 8px",
					fontSize: "11px",
					fontWeight: 500,
					color: "var(--muted-foreground)",
					borderBottom: "1px solid var(--border)",
					backgroundColor: "var(--muted)",
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
					backgroundColor: "#fff",
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
									border: "1px solid var(--border)",
									backgroundColor: "var(--muted)",
									padding: "1px 3px",
									textAlign: "center",
									fontSize: "8px",
									color: "var(--muted-foreground)",
									userSelect: "none",
								}}
							>
								{rowIdx + 1}
							</td>
							{row.cells.map((cell, colIdx) => {
								if (cell.hidden) return null;
								return (
									<DiffCell
										key={`${rowIdx + 1}-${getColumnLabel(colIdx)}`}
										cell={cell}
										cellKey={`${rowIdx + 1}-${getColumnLabel(colIdx)}`}
									/>
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
	absoluteFilePath,
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
	const pendingJumpRef = useRef<DiffLocation | null>(null);
	const [activeSheetIndex, setActiveSheetIndex] = useState(0);

	const activeSheet =
		diffSheets.length > 0
			? diffSheets[Math.min(activeSheetIndex, diffSheets.length - 1)]
			: null;

	const diffLocations = useMemo(
		() =>
			diffSheets.flatMap((sheet, sheetIndex) =>
				getDiffRowIndices(sheet).map((rowIndex) => ({
					sheetIndex,
					rowIndex,
				})),
			),
		[diffSheets],
	);

	const [currentDiffIdx, setCurrentDiffIdx] = useState(0);

	const scrollToDiffRow = useCallback((rowIndex: number) => {
		const left = leftScrollRef.current;
		const right = rightScrollRef.current;
		const leftTarget = left?.querySelectorAll("tbody tr")[rowIndex] as
			| HTMLElement
			| undefined;
		const rightTarget = right?.querySelectorAll("tbody tr")[rowIndex] as
			| HTMLElement
			| undefined;
		const target = leftTarget ?? rightTarget;
		const container = leftTarget ? left : rightTarget ? right : null;
		if (!target || !container) return;
		const containerRect = container.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		const scrollTop =
			container.scrollTop +
			targetRect.top -
			containerRect.top -
			containerRect.height / 2 +
			targetRect.height / 2;
		if (left) left.scrollTop = scrollTop;
		if (right) right.scrollTop = scrollTop;
	}, []);

	const jumpToDiff = useCallback(
		(idx: number) => {
			const location = diffLocations[idx];
			if (!location) return;
			setCurrentDiffIdx(idx);
			if (location.sheetIndex !== activeSheetIndex) {
				pendingJumpRef.current = location;
				setActiveSheetIndex(location.sheetIndex);
				return;
			}
			pendingJumpRef.current = null;
			scrollToDiffRow(location.rowIndex);
		},
		[activeSheetIndex, diffLocations, scrollToDiffRow],
	);

	const goNext = useCallback(() => {
		if (diffLocations.length === 0) return;
		const next =
			currentDiffIdx + 1 < diffLocations.length ? currentDiffIdx + 1 : 0;
		jumpToDiff(next);
	}, [currentDiffIdx, diffLocations.length, jumpToDiff]);

	const goPrev = useCallback(() => {
		if (diffLocations.length === 0) return;
		const prev =
			currentDiffIdx - 1 >= 0 ? currentDiffIdx - 1 : diffLocations.length - 1;
		jumpToDiff(prev);
	}, [currentDiffIdx, diffLocations.length, jumpToDiff]);

	useEffect(() => {
		setActiveSheetIndex((current) =>
			diffSheets.length === 0 ? 0 : Math.min(current, diffSheets.length - 1),
		);
	}, [diffSheets.length]);

	useEffect(() => {
		if (diffLocations.length === 0) {
			setCurrentDiffIdx(0);
			return;
		}
		setCurrentDiffIdx((current) =>
			Math.min(current, Math.max(diffLocations.length - 1, 0)),
		);
	}, [diffLocations.length]);

	useEffect(() => {
		const pendingJump = pendingJumpRef.current;
		if (!pendingJump || pendingJump.sheetIndex !== activeSheetIndex) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			scrollToDiffRow(pendingJump.rowIndex);
			pendingJumpRef.current = null;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activeSheetIndex, scrollToDiffRow]);

	useEffect(() => {
		if (pendingJumpRef.current || diffLocations.length === 0) {
			return;
		}
		const preferredIndex = findPreferredDiffIndex(
			diffLocations,
			activeSheetIndex,
		);
		if (preferredIndex === -1) {
			return;
		}
		jumpToDiff(preferredIndex);
	}, [activeSheetIndex, diffLocations, jumpToDiff]);

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
					justifyContent: "space-between",
					gap: 12,
				}}
			>
				{!commitHash && (
					<SpreadsheetDefaultAppButton absoluteFilePath={absoluteFilePath} />
				)}
				<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
					<span style={{ color: "#a6adc8" }}>
						{diffLocations.length > 0
							? `${diffLocations.length} changes`
							: "No changes"}
					</span>
					{diffLocations.length > 0 && (
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
								{currentDiffIdx + 1} / {diffLocations.length}
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
			</div>
			<div className="flex min-h-0 flex-1">
				<DiffTable
					rows={activeSheet.originalRows}
					columnWidths={activeSheet.columnWidths}
					label="Original (HEAD)"
					scrollRef={leftScrollRef}
					peerScrollRef={rightScrollRef}
				/>
				<div
					style={{
						width: 1,
						backgroundColor: "var(--border)",
						flexShrink: 0,
					}}
				/>
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

function getDiffRowIndices(sheet: DiffParsedSheet): number[] {
	const rowCount = Math.max(
		sheet.originalRows.length,
		sheet.modifiedRows.length,
	);
	const indices: number[] = [];
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const originalHasDiff =
			sheet.originalRows[rowIndex]?.cells.some((cell) => cell.diffStatus) ??
			false;
		const modifiedHasDiff =
			sheet.modifiedRows[rowIndex]?.cells.some((cell) => cell.diffStatus) ??
			false;
		if (originalHasDiff || modifiedHasDiff) {
			indices.push(rowIndex);
		}
	}
	// Empty added/removed sheet: synthesise one location so the header shows
	// "1 change" instead of "No changes" and navigation can reach the sheet.
	if (
		indices.length === 0 &&
		(sheet.sheetStatus === "added" || sheet.sheetStatus === "removed")
	) {
		return [0];
	}
	return indices;
}

function findPreferredDiffIndex(
	diffLocations: DiffLocation[],
	activeSheetIndex: number,
): number {
	const sameSheetIndex = diffLocations.findIndex(
		(location) => location.sheetIndex === activeSheetIndex,
	);
	if (sameSheetIndex !== -1) {
		return sameSheetIndex;
	}
	const nextSheetIndex = diffLocations.findIndex(
		(location) => location.sheetIndex > activeSheetIndex,
	);
	return nextSheetIndex !== -1 ? nextSheetIndex : 0;
}
