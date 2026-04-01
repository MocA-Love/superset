import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { cn } from "@superset/ui/utils";
import { LuChevronDown, LuChevronRight, LuReplace } from "react-icons/lu";
import { FileIcon } from "renderer/screens/main/components/WorkspaceView/RightSidebar/FilesView/utils";
import type { SearchResultGroup } from "../../types";
import { SearchMatchItem } from "../SearchMatchItem";

interface SearchFileGroupProps {
	group: SearchResultGroup;
	isOpen: boolean;
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	isReplacing: boolean;
	showReplaceAction: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenMatch: (absolutePath: string, line: number, column: number) => void;
	onReplaceInFile: (absolutePath: string) => void;
}

function getParentPath(relativePath: string): string {
	const segments = relativePath.split(/[\\/]/);
	if (segments.length <= 1) {
		return ".";
	}
	return segments.slice(0, -1).join("/");
}

export function SearchFileGroup({
	group,
	isOpen,
	query,
	isRegex,
	caseSensitive,
	isReplacing,
	showReplaceAction,
	onOpenChange,
	onOpenMatch,
	onReplaceInFile,
}: SearchFileGroupProps) {
	const parentPath = getParentPath(group.relativePath);

	return (
		<Collapsible open={isOpen} onOpenChange={onOpenChange}>
			<div className="rounded-md border border-border/60 bg-background/60">
				<div className="flex items-start gap-1 px-1.5 py-1.5">
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40"
						>
							<span className="mt-0.5 shrink-0 text-muted-foreground">
								{isOpen ? (
									<LuChevronDown className="size-3.5" />
								) : (
									<LuChevronRight className="size-3.5" />
								)}
							</span>
							<FileIcon
								fileName={group.name}
								className="mt-0.5 size-4 shrink-0"
							/>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium text-foreground">
									{group.name}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{parentPath}
								</div>
							</div>
						</button>
					</CollapsibleTrigger>
					<Badge variant="outline" className="mt-1 shrink-0">
						{group.matches.length}
					</Badge>
					{showReplaceAction ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={cn(
								"h-7 shrink-0 gap-1 px-2 text-xs",
								isReplacing && "pointer-events-none",
							)}
							disabled={isReplacing}
							onClick={() => onReplaceInFile(group.absolutePath)}
						>
							<LuReplace className="size-3.5" />
							Replace
						</Button>
					) : null}
				</div>
				<CollapsibleContent className="border-t border-border/50 px-1.5 py-1">
					<div className="space-y-1">
						{group.matches.map((match) => (
							<SearchMatchItem
								key={match.id}
								match={match}
								query={query}
								isRegex={isRegex}
								caseSensitive={caseSensitive}
								onOpen={onOpenMatch}
							/>
						))}
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
