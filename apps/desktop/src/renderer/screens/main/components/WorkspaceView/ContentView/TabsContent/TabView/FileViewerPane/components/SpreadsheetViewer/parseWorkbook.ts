import type React from "react";

const MAX_ROWS = 2000;

// ── Types ──

type StyleObj = React.CSSProperties;

export interface RichTextPart {
	text: string;
	style: StyleObj;
}

export interface RenderAnchor {
	c: number; // col (0-indexed)
	co: number; // colOff (EMU)
	r: number; // row (0-indexed)
	ro: number; // rowOff (EMU)
}

export interface RenderShape {
	n: string; // name
	t: string; // type ("line" | "rect" etc.)
	vf: boolean; // verticalFlip
	hf: boolean; // horizontalFlip
	tl: RenderAnchor; // top-left anchor
	br: RenderAnchor; // bottom-right anchor
	o: {
		w: number; // outline weight (px)
		cl: string; // outline color
		d: string; // dash style
	};
}

export interface DiagonalBorder {
	up: boolean; // bottom-left to top-right
	down: boolean; // top-left to bottom-right
	style: string; // CSS border style e.g. "1px solid"
	color: string; // e.g. "#000"
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
	diagonal?: DiagonalBorder;
}

export interface ParsedRow {
	excelRow: number; // actual Excel row number (1-based)
	cells: ParsedCell[];
	height: number;
}

export interface ParsedSheet {
	name: string;
	rows: ParsedRow[];
	columnCount: number;
	columnWidths: number[];
	truncated: boolean;
	shapes: RenderShape[];
	/** First data column in Excel (1-based) */
	minCol: number;
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

const SHAPE_THEME_COLORS: Record<string, string> = {
	lt1: "#FFFFFF",
	dk1: "#000000",
	lt2: "#E7E6E6",
	dk2: "#44546A",
	accent1: "#4472C4",
	accent2: "#ED7D31",
	accent3: "#A5A5A5",
	accent4: "#FFC000",
	accent5: "#5B9BD5",
	accent6: "#70AD47",
};

// ── Drawing XML parser (works with standard ExcelJS 4.4.0) ──

function xmlAttr(el: Element, name: string): string {
	return el.getAttribute(name) || "";
}

function _xmlInt(el: Element, name: string): number {
	return Number.parseInt(el.getAttribute(name) || "0", 10);
}

function xmlChild(el: Element, localName: string): Element | null {
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (child.localName === localName) return child;
	}
	return null;
}

function xmlText(el: Element, localName: string): string {
	const child = xmlChild(el, localName);
	return child?.textContent?.trim() || "0";
}

function parseAnchorPosition(el: Element): RenderAnchor {
	return {
		c: Number.parseInt(xmlText(el, "col"), 10),
		co: Number.parseInt(xmlText(el, "colOff"), 10),
		r: Number.parseInt(xmlText(el, "row"), 10),
		ro: Number.parseInt(xmlText(el, "rowOff"), 10),
	};
}

function resolveXmlColor(el: Element | null): string {
	if (!el) return "#000000";
	// <a:srgbClr val="FF0000"/>
	const srgb = xmlChild(el, "srgbClr");
	if (srgb) return `#${xmlAttr(srgb, "val")}`;
	// <a:schemeClr val="accent1"/>
	const scheme = xmlChild(el, "schemeClr");
	if (scheme) {
		const val = xmlAttr(scheme, "val");
		return SHAPE_THEME_COLORS[val] || "#000000";
	}
	return "#000000";
}

function parseShapeFromAnchor(anchor: Element): RenderShape | null {
	const from = xmlChild(anchor, "from");
	const to = xmlChild(anchor, "to");
	if (!from || !to) return null;

	// Look for sp (shape) or cxnSp (connector)
	const sp = xmlChild(anchor, "sp") || xmlChild(anchor, "cxnSp");
	if (!sp) return null;

	// Get name from nvSpPr/cNvPr or nvCxnSpPr/cNvPr
	const nvPr = xmlChild(sp, "nvSpPr") || xmlChild(sp, "nvCxnSpPr");
	const cNvPr = nvPr ? xmlChild(nvPr, "cNvPr") : null;
	const name = cNvPr ? xmlAttr(cNvPr, "name") : "";

	// Get shape properties
	const spPr = xmlChild(sp, "spPr");
	if (!spPr) return null;

	// Determine shape type from prstGeom
	const prstGeom = xmlChild(spPr, "prstGeom");
	const prst = prstGeom ? xmlAttr(prstGeom, "prst") : "";
	const isLine = prst === "line" || sp.localName === "cxnSp";

	// Get transform (flip, rotation)
	const xfrm = xmlChild(spPr, "xfrm");
	const flipH = xfrm ? xmlAttr(xfrm, "flipH") === "1" : false;
	const flipV = xfrm ? xmlAttr(xfrm, "flipV") === "1" : false;

	// Get line properties
	const ln = xmlChild(spPr, "ln");
	let lineWidth = 1;
	let lineColor = "#000000";
	let lineDash = "solid";

	if (ln) {
		const w = xmlAttr(ln, "w");
		if (w) lineWidth = (Number.parseInt(w, 10) / 12700) * (96 / 72);
		const fill = xmlChild(ln, "solidFill");
		if (fill) lineColor = resolveXmlColor(fill);
		const dash = xmlChild(ln, "prstDash");
		if (dash) lineDash = xmlAttr(dash, "val") || "solid";
	}

	return {
		n: name,
		t: isLine ? "line" : prst || "rect",
		vf: flipV,
		hf: flipH,
		tl: parseAnchorPosition(from),
		br: parseAnchorPosition(to),
		o: { w: lineWidth, cl: lineColor, d: lineDash },
	};
}

async function parseDrawingsFromZip(
	zipBuffer: ArrayBuffer,
): Promise<Map<number, RenderShape[]>> {
	// biome-ignore lint/suspicious/noExplicitAny: jszip has no type declarations in this context
	const JSZip = (await import("jszip" as any)).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const parser = new DOMParser();
	const result = new Map<number, RenderShape[]>();

	const files = zip.files as Record<
		string,
		{ dir: boolean; async: (type: string) => Promise<string> }
	>;

	// Find which sheet links to which drawing via rels files
	const sheetDrawingMap = new Map<string, number>();
	for (const [name, file] of Object.entries(files)) {
		const relsMatch = name.match(
			/xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/,
		);
		if (!relsMatch || file.dir) continue;
		const sheetIndex = Number.parseInt(relsMatch[1], 10);
		const relsXml = await file.async("text");
		const doc = parser.parseFromString(relsXml, "application/xml");
		const rels = doc.getElementsByTagName("Relationship");
		for (let i = 0; i < rels.length; i++) {
			const target = rels[i].getAttribute("Target") || "";
			const drawingMatch = target.match(/drawing(\d+)\.xml$/);
			if (drawingMatch) {
				sheetDrawingMap.set(`drawing${drawingMatch[1]}`, sheetIndex);
			}
		}
	}

	// Parse each drawing XML
	for (const [name, file] of Object.entries(files)) {
		const drawingMatch = name.match(/xl\/drawings\/(drawing\d+)\.xml$/);
		if (!drawingMatch || file.dir) continue;
		const drawingId = drawingMatch[1];
		const sheetIndex = sheetDrawingMap.get(drawingId);
		if (sheetIndex === undefined) continue;

		const xml = await file.async("text");
		const doc = parser.parseFromString(xml, "application/xml");
		const shapes: RenderShape[] = [];

		// Parse twoCellAnchor elements
		const anchors = doc.getElementsByTagNameNS("*", "twoCellAnchor");
		for (let i = 0; i < anchors.length; i++) {
			const shape = parseShapeFromAnchor(anchors[i]);
			if (shape) shapes.push(shape);
		}

		if (shapes.length > 0) {
			result.set(sheetIndex, shapes);
		}
	}

	return result;
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

// biome-ignore lint/suspicious/noExplicitAny: ExcelJS internal types are incomplete
function getCellDiagonal(cell: any): DiagonalBorder | undefined {
	const bd = cell.border;
	if (!bd?.diagonal?.style) return undefined;
	const up = bd.diagonal.up === true;
	const down = bd.diagonal.down === true;
	if (!up && !down) return undefined;
	const base = BORDER_STYLES[bd.diagonal.style] || "1px solid";
	const color = resolveColor(bd.diagonal.color) || "#000";
	return { up, down, style: base, color };
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
	const buffer = bytes.buffer as ArrayBuffer;
	await workbook.xlsx.load(buffer);

	// Parse drawing objects (shapes/lines) directly from the xlsx ZIP
	// since standard ExcelJS 4.4.0 only supports images, not shapes.
	const drawingsMap = await parseDrawingsFromZip(buffer);

	const sheets: ParsedSheet[] = [];
	let sheetIndex = 0;

	workbook.eachSheet((worksheet) => {
		sheetIndex++;
		const dims = getSheetDimensions(worksheet);
		const mergeMap = buildMergeMap(worksheet);
		const shapes = drawingsMap.get(sheetIndex) || [];
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

				const diagonal = getCellDiagonal(cell);

				const parsed: ParsedCell = { value: val, style };
				if (mergeInfo) {
					parsed.colSpan = colspan;
					parsed.rowSpan = rowspan;
				}
				if (wrapText) parsed.wrapText = true;
				if (verticalText) parsed.verticalText = true;
				if (richText) parsed.richText = richText;
				if (diagonal) parsed.diagonal = diagonal;
				cells.push(parsed);
			}

			rows.push({ excelRow: r, cells, height: rowHeightToPx(row.height) });
		}

		sheets.push({
			name: worksheet.name,
			rows,
			columnCount: colCount,
			columnWidths,
			truncated,
			shapes,
			minCol: dims.minC,
		});
	});

	return sheets;
}
