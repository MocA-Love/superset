import { diffChars } from "diff";
import { useEffect, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ChangeCategory } from "shared/changes-types";
import type { ParsedCell, ParsedSheet } from "./useSpreadsheetData";

const MAX_SPREADSHEET_SIZE = 10 * 1024 * 1024;

export interface DiffSegment {
	text: string;
	type: "added" | "removed" | "unchanged";
}

export interface DiffParsedCell extends ParsedCell {
	diffStatus?: "added" | "removed" | "modified";
	diffSegments?: DiffSegment[];
}

export interface DiffParsedRow {
	cells: DiffParsedCell[];
	height: number;
}

export interface DiffParsedSheet {
	name: string;
	originalRows: DiffParsedRow[];
	modifiedRows: DiffParsedRow[];
	columnCount: number;
	columnWidths: number[];
	sheetStatus?: "added" | "removed";
}

function computeDiffSegments(
	oldValue: string,
	newValue: string,
	side: "original" | "modified",
): DiffSegment[] {
	const changes = diffChars(oldValue, newValue);
	const segments: DiffSegment[] = [];
	for (const change of changes) {
		if (change.added) {
			if (side === "modified") {
				segments.push({ text: change.value, type: "added" });
			}
			// skip added parts on original side
		} else if (change.removed) {
			if (side === "original") {
				segments.push({ text: change.value, type: "removed" });
			}
			// skip removed parts on modified side
		} else {
			segments.push({ text: change.value, type: "unchanged" });
		}
	}
	return segments;
}

async function parseBase64Workbook(
	base64Content: string,
): Promise<ParsedSheet[]> {
	const { parseWorkbook } = await import("./parseWorkbook");
	return parseWorkbook(base64Content);
}

function compareCellValue(a: ParsedCell, b: ParsedCell): boolean {
	return a.value === b.value;
}

function buildDiffSheets(
	originalSheets: ParsedSheet[],
	modifiedSheets: ParsedSheet[],
): DiffParsedSheet[] {
	const result: DiffParsedSheet[] = [];

	const origMap = new Map(originalSheets.map((s) => [s.name, s]));
	const modMap = new Map(modifiedSheets.map((s) => [s.name, s]));

	const allNames = new Set([...origMap.keys(), ...modMap.keys()]);

	for (const name of allNames) {
		const orig = origMap.get(name);
		const mod = modMap.get(name);

		if (!orig && mod) {
			result.push({
				name,
				originalRows: [],
				modifiedRows: mod.rows.map((r) => ({
					...r,
					cells: r.cells.map((c) => ({ ...c, diffStatus: "added" as const })),
				})),
				columnCount: mod.columnCount,
				columnWidths: mod.columnWidths,
				sheetStatus: "added",
			});
			continue;
		}

		if (orig && !mod) {
			result.push({
				name,
				originalRows: orig.rows.map((r) => ({
					...r,
					cells: r.cells.map((c) => ({
						...c,
						diffStatus: "removed" as const,
					})),
				})),
				modifiedRows: [],
				columnCount: orig.columnCount,
				columnWidths: orig.columnWidths,
				sheetStatus: "removed",
			});
			continue;
		}

		if (orig && mod) {
			const maxRows = Math.max(orig.rows.length, mod.rows.length);
			const maxCols = Math.max(orig.columnCount, mod.columnCount);
			const colWidths =
				mod.columnWidths.length >= orig.columnWidths.length
					? mod.columnWidths
					: orig.columnWidths;

			const origRows: DiffParsedRow[] = [];
			const modRows: DiffParsedRow[] = [];

			for (let r = 0; r < maxRows; r++) {
				const origRow = orig.rows[r];
				const modRow = mod.rows[r];

				const origCells: DiffParsedCell[] = [];
				const modCells: DiffParsedCell[] = [];

				for (let c = 0; c < maxCols; c++) {
					const origCell = origRow?.cells[c];
					const modCell = modRow?.cells[c];

					const emptyCell: DiffParsedCell = {
						value: "",
						style: {},
					};

					if (!origCell && modCell) {
						origCells.push(emptyCell);
						modCells.push({
							...modCell,
							diffStatus: modCell.value ? "added" : undefined,
						});
					} else if (origCell && !modCell) {
						origCells.push({
							...origCell,
							diffStatus: origCell.value ? "removed" : undefined,
						});
						modCells.push(emptyCell);
					} else if (origCell && modCell) {
						const changed = !compareCellValue(origCell, modCell);
						origCells.push({
							...origCell,
							diffStatus: changed ? "modified" : undefined,
							diffSegments: changed
								? computeDiffSegments(origCell.value, modCell.value, "original")
								: undefined,
						});
						modCells.push({
							...modCell,
							diffStatus: changed ? "modified" : undefined,
							diffSegments: changed
								? computeDiffSegments(origCell.value, modCell.value, "modified")
								: undefined,
						});
					} else {
						origCells.push(emptyCell);
						modCells.push(emptyCell);
					}
				}

				origRows.push({
					cells: origCells,
					height: origRow?.height ?? modRow?.height ?? 20,
				});
				modRows.push({
					cells: modCells,
					height: modRow?.height ?? origRow?.height ?? 20,
				});
			}

			result.push({
				name,
				originalRows: origRows,
				modifiedRows: modRows,
				columnCount: maxCols,
				columnWidths: colWidths,
			});
		}
	}

	return result;
}

interface UseSpreadsheetDiffParams {
	workspaceId: string;
	worktreePath: string;
	filePath: string;
	diffCategory?: ChangeCategory;
	commitHash?: string;
}

interface UseSpreadsheetDiffResult {
	diffSheets: DiffParsedSheet[];
	isLoading: boolean;
	error: string | null;
	debug: Record<string, unknown>;
}

export function useSpreadsheetDiff({
	workspaceId,
	worktreePath,
	filePath,
	diffCategory,
	commitHash,
}: UseSpreadsheetDiffParams): UseSpreadsheetDiffResult {
	const [diffSheets, setDiffSheets] = useState<DiffParsedSheet[]>([]);
	const [isParsing, setIsParsing] = useState(false);
	const [parseError, setParseError] = useState<string | null>(null);

	// Determine git refs for original and modified
	const refs = useMemo(() => {
		switch (diffCategory) {
			case "staged":
				return { originalRef: "HEAD", modifiedRef: undefined }; // modified = staged (:0:)
			case "committed":
				return {
					originalRef: commitHash ? `${commitHash}^` : "HEAD",
					modifiedRef: commitHash ?? "HEAD",
				};
			case "against-base":
				return { originalRef: "origin/main", modifiedRef: "HEAD" };
			default:
				// unstaged: original from git, modified from disk
				return { originalRef: "HEAD", modifiedRef: undefined };
		}
	}, [diffCategory, commitHash]);

	const isUnstaged = !diffCategory || diffCategory === "unstaged";

	// Fetch original from git
	const originalQuery = electronTrpc.changes.readGitFileBinary.useQuery(
		{
			worktreePath,
			absolutePath: filePath,
			ref: refs.originalRef ?? "HEAD",
		},
		{ retry: false, refetchOnWindowFocus: false, enabled: !!worktreePath },
	);

	// Fetch modified: from git ref or from disk
	const modifiedGitQuery = electronTrpc.changes.readGitFileBinary.useQuery(
		{
			worktreePath,
			absolutePath: filePath,
			ref: refs.modifiedRef ?? "HEAD",
		},
		{
			retry: false,
			refetchOnWindowFocus: false,
			enabled: !!worktreePath && !isUnstaged && !!refs.modifiedRef,
		},
	);

	const modifiedDiskQuery = electronTrpc.filesystem.readFile.useQuery(
		{
			workspaceId,
			absolutePath: filePath,
			maxBytes: MAX_SPREADSHEET_SIZE,
		},
		{
			retry: false,
			refetchOnWindowFocus: false,
			enabled: isUnstaged,
		},
	);

	const originalBase64 = originalQuery.data?.content ?? null;
	const modifiedBase64 = isUnstaged
		? ((modifiedDiskQuery.data?.content as string) ?? null)
		: (modifiedGitQuery.data?.content ?? null);

	const isLoading =
		originalQuery.isLoading ||
		(isUnstaged ? modifiedDiskQuery.isLoading : modifiedGitQuery.isLoading) ||
		isParsing;

	useEffect(() => {
		if (!originalBase64 && !modifiedBase64) return;

		let cancelled = false;
		setIsParsing(true);
		setParseError(null);

		Promise.all([
			originalBase64
				? parseBase64Workbook(originalBase64)
				: Promise.resolve([]),
			modifiedBase64
				? parseBase64Workbook(modifiedBase64)
				: Promise.resolve([]),
		])
			.then(([origSheets, modSheets]) => {
				if (!cancelled) {
					setDiffSheets(buildDiffSheets(origSheets, modSheets));
					setIsParsing(false);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setParseError(
						err instanceof Error ? err.message : "Failed to parse spreadsheet",
					);
					setIsParsing(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [originalBase64, modifiedBase64]);

	const error =
		originalQuery.error || modifiedGitQuery.error || modifiedDiskQuery.error
			? "Failed to load file"
			: parseError;

	const debug = {
		diffCategory: diffCategory ?? "undefined",
		isUnstaged,
		originalRef: refs.originalRef,
		modifiedRef: refs.modifiedRef ?? "disk",
		originalLoading: originalQuery.isLoading,
		originalHasData: !!originalBase64,
		originalError: originalQuery.error?.message ?? null,
		modifiedLoading: isUnstaged
			? modifiedDiskQuery.isLoading
			: modifiedGitQuery.isLoading,
		modifiedHasData: !!modifiedBase64,
		modifiedError: isUnstaged
			? (modifiedDiskQuery.error?.message ?? null)
			: (modifiedGitQuery.error?.message ?? null),
		sheetsCount: diffSheets.length,
		isParsing,
	};

	return { diffSheets, isLoading, error, debug };
}
