import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ParsedSheet } from "./parseWorkbook";

export type {
	DiagonalBorder,
	ParsedCell,
	ParsedRow,
	ParsedSheet,
	RenderAnchor,
	RenderShape,
	RichTextPart,
} from "./parseWorkbook";

const MAX_SPREADSHEET_SIZE = 10 * 1024 * 1024;

interface UseSpreadsheetDataResult {
	sheets: ParsedSheet[];
	isLoading: boolean;
	error: string | null;
}

export function useSpreadsheetData(
	workspaceId: string,
	filePath: string,
): UseSpreadsheetDataResult {
	const [sheets, setSheets] = useState<ParsedSheet[]>([]);
	const [isParsing, setIsParsing] = useState(false);
	const [parseError, setParseError] = useState<string | null>(null);

	const query = electronTrpc.filesystem.readFile.useQuery(
		{
			workspaceId,
			absolutePath: filePath,
			maxBytes: MAX_SPREADSHEET_SIZE,
		},
		{ retry: false, refetchOnWindowFocus: false },
	);

	useEffect(() => {
		if (!query.data) return;

		if (query.data.exceededLimit) {
			setParseError("File is too large to preview (>10MB)");
			return;
		}

		let cancelled = false;
		setIsParsing(true);
		setParseError(null);

		import("./parseWorkbook")
			.then(({ parseWorkbook }) => parseWorkbook(query.data?.content as string))
			.then((parsed) => {
				if (!cancelled) {
					setSheets(parsed);
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
	}, [query.data]);

	const error = query.error ? "Failed to load file" : parseError;

	return {
		sheets,
		isLoading: query.isLoading || isParsing,
		error,
	};
}
