import { highlightSearchText } from "../../utils/searchPattern/searchPattern";
import type { SearchContentResult } from "../../types";

interface SearchMatchItemProps {
	match: SearchContentResult;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	onOpen: (absolutePath: string, line: number, column: number) => void;
}

export function SearchMatchItem({
	match,
	query,
	isRegex,
	caseSensitive,
	onOpen,
}: SearchMatchItemProps) {
	return (
		<button
			type="button"
			className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
			onClick={() => onOpen(match.absolutePath, match.line, match.column)}
		>
			<span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
				{match.line}:{match.column}
			</span>
			<div className="min-w-0 flex-1 text-xs leading-5 text-foreground">
				<div className="break-words">
					{highlightSearchText(match.preview, {
						query,
						isRegex,
						caseSensitive,
					})}
				</div>
			</div>
		</button>
	);
}
