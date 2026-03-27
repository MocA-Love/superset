import type React from "react";

const MAX_ROWS = 2000;

// ── Types ──

type StyleObj = React.CSSProperties;

export interface RichTextPart {
	text: string;
	style: StyleObj;
}

export interface ParsedCell {
	value: string;
	style: StyleObj;
	colSpan?: number;
	rowSpan?: number;
	hidden?: boolean;
	wrapText?: boolean;
	verticalText?: boolean;
	richText?: RichTextPart[];
}

export interface ParsedRow {
	cells: ParsedCell[];
	height: number;
}

export interface ParsedSheet {
	name: string;
	rows: ParsedRow[];
	columnCount: number;
	columnWidths: number[];
	truncated: boolean;
}

// ── Theme colors (standard Excel Office theme) ──

const THEME_COLORS: Record<number, string> = {
	0: "#FFFFFF",
	1: "#000000",
	2: "#E7E6E6",
	3: "#44546A",
	4: "#4472C4",
	5: "#ED7D31",
	6: "#A5A5A5",
	7: "#FFC000",
	8: "#5B9BD5",
	9: "#70AD47",
};

const BORDER_STYLES: Record<string, string> = {
	thin: "1px solid",
	medium: "2px solid",
	thick: "3px solid",
	dotted: "1px dotted",
	dashed: "1px dashed",
	double: "3px double",
	mediumDashed: "2px dashed",
	dashDot: "1px dashed",
	dashDotDot: "1px dashed",
	mediumDashDot: "2px dashed",
	mediumDashDotDot: "2px dashed",
	slantDashDot: "1px dashed",
	hair: "1px solid",
};

// ── Color resolution ──

function argbToHex(argb: string | undefined): string | null {
	if (!argb || argb.length < 6) return null;
	const hex = argb.length === 8 ? argb.slice(2) : argb;
	if (/^0+$/.test(hex)) return null;
	return `#${hex}`;
}

function applyTint(hex: string, tint: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const apply = (c: number) =>
		tint < 0 ? Math.round(c * (1 + tint)) : Math.round(c + (255 - c) * tint);
	const clamp = (v: number) => Math.min(255, Math.max(0, v));
	return `#${clamp(apply(r)).toString(16).padStart(2, "0")}${clamp(apply(g)).toString(16).padStart(2, "0")}${clamp(apply(b)).toString(16).padStart(2, "0")}`;
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function resolveColor(color: any): string | null {
	if (!color) return null;
	if (color.argb) return argbToHex(color.argb);
	if (color.theme !== undefined) {
		const base = THEME_COLORS[color.theme] || "#000000";
		return color.tint ? applyTint(base, color.tint) : base;
	}
	if (color.indexed !== undefined)
		return color.indexed === 64 ? "#000000" : null;
	return null;
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function borderToCSS(b: any): string | null {
	if (!b?.style) return null;
	const base = BORDER_STYLES[b.style] || "1px solid";
	const col = resolveColor(b.color) || "#000";
	return `${base} ${col}`;
}

function rowHeightToPx(h: number | undefined): number {
	if (!h || h <= 0) return 20;
	return Math.round((h * 96) / 72);
}

function charWidthToPx(w: number | undefined): number {
	if (!w || w <= 0) return 64;
	return Math.max(4, Math.round(w * 10));
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function richTextFontStyle(font: any): StyleObj {
	const s: StyleObj = {};
	if (!font) return s;
	if (font.size) s.fontSize = `${font.size}pt`;
	if (font.name) s.fontFamily = `'${font.name}', sans-serif`;
	if (font.bold) s.fontWeight = "bold";
	if (font.italic) s.fontStyle = "italic";
	const decor: string[] = [];
	if (font.underline) decor.push("underline");
	if (font.strike) decor.push("line-through");
	if (decor.length) s.textDecoration = decor.join(" ");
	const fc = resolveColor(font.color);
	if (fc && fc !== "#FFFFFF") s.color = fc;
	if (font.vertAlign === "superscript") {
		s.verticalAlign = "super";
		s.fontSize = s.fontSize || "0.7em";
	}
	if (font.vertAlign === "subscript") {
		s.verticalAlign = "sub";
		s.fontSize = s.fontSize || "0.7em";
	}
	return s;
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function getCellStyle(cell: any): StyleObj {
	const style: StyleObj = { verticalAlign: "bottom" };
	const al = cell.alignment;
	if (al) {
		const hmap: Record<string, string> = {
			left: "left",
			center: "center",
			right: "right",
			fill: "left",
			justify: "justify",
			centerContinuous: "center",
			distributed: "center",
		};
		const vmap: Record<string, string> = {
			top: "top",
			middle: "middle",
			center: "middle",
			bottom: "bottom",
			distributed: "middle",
			justify: "middle",
		};
		if (al.horizontal)
			style.textAlign = (hmap[al.horizontal] ||
				"left") as StyleObj["textAlign"];
		style.verticalAlign = ((al.vertical && vmap[al.vertical]) ||
			"bottom") as StyleObj["verticalAlign"];
		if (al.indent) style.paddingLeft = `${al.indent * 8 + 3}px`;
	}
	const f = cell.font;
	if (f) {
		if (f.size) style.fontSize = `${f.size}pt`;
		if (f.name) style.fontFamily = `'${f.name}', sans-serif`;
		if (f.bold) style.fontWeight = "bold";
		if (f.italic) style.fontStyle = "italic";
		const decor: string[] = [];
		if (f.underline) decor.push("underline");
		if (f.strike) decor.push("line-through");
		if (decor.length) style.textDecoration = decor.join(" ");
		const fc = resolveColor(f.color);
		if (fc && fc !== "#FFFFFF") style.color = fc;
	}
	const fill = cell.fill;
	if (fill?.type === "pattern" && fill.pattern === "solid") {
		const bg = resolveColor(fill.fgColor);
		if (bg) style.backgroundColor = bg;
	}
	const bd = cell.border;
	if (bd) {
		const bt = borderToCSS(bd.top);
		if (bt) style.borderTop = bt;
		const bb = borderToCSS(bd.bottom);
		if (bb) style.borderBottom = bb;
		const bl = borderToCSS(bd.left);
		if (bl) style.borderLeft = bl;
		const br = borderToCSS(bd.right);
		if (br) style.borderRight = br;
	}
	return style;
}

function getMergedCellBorders(
	// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
	ws: any,
	r: number,
	c: number,
	rowspan: number,
	colspan: number,
): StyleObj {
	const borders: StyleObj = {};
	const getBorder = (row: number, col: number) =>
		ws.getRow(row).getCell(col).border;
	const topBd = getBorder(r, c);
	if (topBd?.top) {
		const v = borderToCSS(topBd.top);
		if (v) borders.borderTop = v;
	}
	if (topBd?.left) {
		const v = borderToCSS(topBd.left);
		if (v) borders.borderLeft = v;
	}
	const bottomRow = r + rowspan - 1;
	for (let cc = c; cc < c + colspan; cc++) {
		const bd = getBorder(bottomRow, cc);
		if (bd?.bottom) {
			const v = borderToCSS(bd.bottom);
			if (v) {
				borders.borderBottom = v;
				break;
			}
		}
	}
	const rightCol = c + colspan - 1;
	for (let rr = r; rr < r + rowspan; rr++) {
		const bd = getBorder(rr, rightCol);
		if (bd?.right) {
			const v = borderToCSS(bd.right);
			if (v) {
				borders.borderRight = v;
				break;
			}
		}
	}
	return borders;
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function getCellDisplayValue(cell: any): string {
	if (cell.type === 2) return "";
	if (cell.value?.richText) {
		// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
		return cell.value.richText.map((rt: any) => rt.text || "").join("");
	}
	if (cell.value?.formula) {
		const r = cell.value.result;
		return r != null ? String(r) : "";
	}
	if (cell.value instanceof Date) return cell.value.toLocaleDateString();
	if (cell.text != null) return String(cell.text);
	if (cell.value != null) return String(cell.value);
	return "";
}

interface MergeOrigin {
	rowspan: number;
	colspan: number;
}
type MergeEntry = MergeOrigin | { skip: true };

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function buildMergeMap(ws: any): Record<string, MergeEntry> {
	const mm: Record<string, MergeEntry> = {};
	const model = ws.model;
	if (!model?.merges) return mm;
	for (const range of model.merges) {
		const parts = range.split(":");
		if (parts.length !== 2) continue;
		const s = decodeAddr(parts[0]);
		const e = decodeAddr(parts[1]);
		for (let r = s.r; r <= e.r; r++) {
			for (let c = s.c; c <= e.c; c++) {
				const key = `${r},${c}`;
				if (r === s.r && c === s.c)
					mm[key] = { rowspan: e.r - s.r + 1, colspan: e.c - s.c + 1 };
				else mm[key] = { skip: true };
			}
		}
	}
	return mm;
}

function decodeAddr(addr: string): { r: number; c: number } {
	const m = addr.match(/^([A-Z]+)(\d+)$/);
	if (!m) return { r: 1, c: 1 };
	const col = m[1]
		.split("")
		.reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
	return { r: Number.parseInt(m[2], 10), c: col };
}

interface SheetDims {
	minR: number;
	maxR: number;
	minC: number;
	maxC: number;
}

function parsePrintArea(area: string): SheetDims | null {
	const clean = area.replace(/\$/g, "");
	const m = clean.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
	if (!m) return null;
	const colToNum = (s: string) =>
		s.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
	return {
		minC: colToNum(m[1]),
		minR: Number.parseInt(m[2], 10),
		maxC: colToNum(m[3]),
		maxR: Number.parseInt(m[4], 10),
	};
}

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function getSheetDimensions(ws: any): SheetDims {
	const printArea = ws.pageSetup?.printArea;
	if (printArea) {
		const parsed = parsePrintArea(printArea.split(",")[0].trim());
		if (parsed) return parsed;
	}
	const dims = ws.dimensions;
	if (dims)
		return {
			minR: dims.top || 1,
			maxR: dims.bottom || 1,
			minC: dims.left || 1,
			maxC: dims.right || 1,
		};
	return {
		minR: 1,
		maxR: ws.rowCount || 1,
		minC: 1,
		maxC: ws.columnCount || 1,
	};
}

// ── Main parser ──

export async function parseWorkbook(
	base64Content: string,
): Promise<ParsedSheet[]> {
	const ExcelJS = await import("exceljs");
	const workbook = new ExcelJS.Workbook();
	const binaryStr = atob(base64Content);
	const bytes = new Uint8Array(binaryStr.length);
	for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
	await workbook.xlsx.load(bytes.buffer as ArrayBuffer);

	const sheets: ParsedSheet[] = [];

	workbook.eachSheet((worksheet) => {
		const dims = getSheetDimensions(worksheet);
		const mergeMap = buildMergeMap(worksheet);
		const colCount = dims.maxC - dims.minC + 1;
		const columnWidths: number[] = [];
		for (let c = dims.minC; c <= dims.maxC; c++) {
			const col = worksheet.getColumn(c);
			columnWidths.push(col.hidden ? 0 : charWidthToPx(col.width));
		}

		const rows: ParsedRow[] = [];
		const maxRow = Math.min(dims.maxR, dims.minR + MAX_ROWS - 1);
		const truncated = dims.maxR > maxRow;

		for (let r = dims.minR; r <= maxRow; r++) {
			const row = worksheet.getRow(r);
			if (row.hidden) continue;
			const cells: ParsedCell[] = [];

			for (let c = dims.minC; c <= dims.maxC; c++) {
				const key = `${r},${c}`;
				const mergeEntry = mergeMap[key];
				if (mergeEntry && "skip" in mergeEntry) {
					cells.push({ value: "", style: {}, hidden: true });
					continue;
				}

				// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
				const cell = row.getCell(c) as any;
				const val = getCellDisplayValue(cell);
				let style = getCellStyle(cell);
				const mergeInfo =
					mergeEntry && "rowspan" in mergeEntry ? mergeEntry : null;
				const colspan = mergeInfo?.colspan ?? 1;
				const rowspan = mergeInfo?.rowspan ?? 1;

				if (mergeInfo) {
					const {
						borderTop: _bt,
						borderBottom: _bb,
						borderLeft: _bl,
						borderRight: _br,
						...rest
					} = style as Record<string, unknown>;
					style = {
						...rest,
						...getMergedCellBorders(worksheet, r, c, rowspan, colspan),
					} as StyleObj;
				}

				const isRichText = !!cell.value?.richText;
				const richText: RichTextPart[] | undefined = isRichText
					? // biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
						cell.value.richText.map((rt: any) => ({
							text: rt.text || "",
							style: richTextFontStyle(rt.font),
						}))
					: undefined;

				const al = cell.alignment;
				const wrapText =
					al?.wrapText === true ||
					(typeof val === "string" && val.includes("\n"));
				const verticalText =
					al?.textRotation === "vertical" || al?.textRotation === 255;

				const parsed: ParsedCell = { value: val, style };
				if (mergeInfo) {
					parsed.colSpan = colspan;
					parsed.rowSpan = rowspan;
				}
				if (wrapText) parsed.wrapText = true;
				if (verticalText) parsed.verticalText = true;
				if (richText) parsed.richText = richText;
				cells.push(parsed);
			}

			rows.push({ cells, height: rowHeightToPx(row.height) });
		}

		sheets.push({
			name: worksheet.name,
			rows,
			columnCount: colCount,
			columnWidths,
			truncated,
		});
	});

	return sheets;
}
