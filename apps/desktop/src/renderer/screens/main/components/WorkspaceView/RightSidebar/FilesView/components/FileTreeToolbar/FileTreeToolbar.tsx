import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback } from "react";
import {
	LuChevronsDownUp,
	LuFilePlus,
	LuFolderPlus,
	LuMessageSquareText,
	LuRefreshCw,
	LuX,
} from "react-icons/lu";
import { useFileExplorerStore } from "renderer/stores/file-explorer";

interface FileTreeToolbarProps {
	searchTerm: string;
	onSearchChange: (term: string) => void;
	onNewFile: () => void;
	onNewFolder: () => void;
	onCollapseAll: () => void;
	onRefresh: () => void;
	isRefreshing?: boolean;
}

export function FileTreeToolbar({
	searchTerm,
	onSearchChange,
	onNewFile,
	onNewFolder,
	onCollapseAll,
	onRefresh,
	isRefreshing = false,
}: FileTreeToolbarProps) {
	const { showFileTooltips, toggleFileTooltips } = useFileExplorerStore();

	// Debounce lives entirely in `useFileSearch` so the input stays responsive
	// and we avoid the two-layer debounce chain that previously delayed renders
	// unpredictably depending on stale closures.
	const handleSearchChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			onSearchChange(e.target.value);
		},
		[onSearchChange],
	);

	const handleClearSearch = useCallback(() => {
		onSearchChange("");
	}, [onSearchChange]);

	return (
		<div className="flex flex-col gap-1 px-2 py-1.5 border-b border-border">
			<div className="relative">
				<Input
					type="text"
					placeholder="Search files..."
					value={searchTerm}
					onChange={handleSearchChange}
					className="h-7 text-xs pr-7"
				/>
				{searchTerm && (
					<button
						type="button"
						onClick={handleClearSearch}
						className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20 transition-colors"
					>
						<LuX className="size-3.5" />
					</button>
				)}
			</div>

			<div className="flex items-center gap-0.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							onClick={onNewFile}
						>
							<LuFilePlus className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">New File</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							onClick={onNewFolder}
						>
							<LuFolderPlus className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">New Folder</TooltipContent>
				</Tooltip>

				<div className="flex-1" />

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							onClick={onCollapseAll}
						>
							<LuChevronsDownUp className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Collapse All</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							onClick={onRefresh}
							disabled={isRefreshing}
						>
							<LuRefreshCw
								className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Refresh</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className={`size-6 ${showFileTooltips ? "bg-accent" : ""}`}
							onClick={toggleFileTooltips}
						>
							<LuMessageSquareText className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						{showFileTooltips ? "Hide Tooltips" : "Show Tooltips"}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
