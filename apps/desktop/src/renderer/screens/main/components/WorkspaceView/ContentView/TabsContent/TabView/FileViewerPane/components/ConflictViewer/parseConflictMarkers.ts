export type ConflictSide = "current" | "separator" | "incoming";

export interface ConflictRegion {
	/** 1-based line number of the <<<<<<< HEAD marker */
	startLine: number;
	/** 1-based line number of the ======= separator */
	separatorLine: number;
	/** 1-based line number of the >>>>>>> branch marker */
	endLine: number;
	/** Lines belonging to the current (HEAD) side */
	currentLines: { lineNumber: number; text: string }[];
	/** Lines belonging to the incoming (theirs) side */
	incomingLines: { lineNumber: number; text: string }[];
	/** Label from the <<<<<<< marker (e.g. "HEAD") */
	currentLabel: string;
	/** Label from the >>>>>>> marker (e.g. branch name) */
	incomingLabel: string;
}

export function parseConflictMarkers(content: string): ConflictRegion[] {
	const lines = content.split("\n");
	const regions: ConflictRegion[] = [];

	let state: "none" | "current" | "incoming" = "none";
	let startLine = 0;
	let separatorLine = 0;
	let currentLines: { lineNumber: number; text: string }[] = [];
	let incomingLines: { lineNumber: number; text: string }[] = [];
	let currentLabel = "";
	let incomingLabel = "";

	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		const line = lines[i] ?? "";

		if (line.startsWith("<<<<<<<")) {
			if (state === "none") {
				state = "current";
				startLine = lineNumber;
				currentLabel = line.slice(8).trim();
				currentLines = [];
				incomingLines = [];
			}
		} else if (line.startsWith("=======") && state === "current") {
			state = "incoming";
			separatorLine = lineNumber;
		} else if (line.startsWith(">>>>>>>") && state === "incoming") {
			incomingLabel = line.slice(8).trim();
			regions.push({
				startLine,
				separatorLine,
				endLine: lineNumber,
				currentLines,
				incomingLines,
				currentLabel,
				incomingLabel,
			});
			state = "none";
			currentLines = [];
			incomingLines = [];
		} else if (state === "current") {
			currentLines.push({ lineNumber, text: line });
		} else if (state === "incoming") {
			incomingLines.push({ lineNumber, text: line });
		}
	}

	return regions;
}
