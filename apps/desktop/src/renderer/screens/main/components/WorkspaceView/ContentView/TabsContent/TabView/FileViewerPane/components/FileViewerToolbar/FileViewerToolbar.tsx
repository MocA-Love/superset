import { ToggleGroup, ToggleGroupItem } from "@superset/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useCallback, useMemo } from "react";
import { LuMinus, LuPlus, LuRefreshCw } from "react-icons/lu";
import {
	TbFold,
	TbLayoutSidebarRightFilled,
	TbListDetails,
	TbPinFilled,
} from "react-icons/tb";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import type { DiffViewMode } from "shared/changes-types";
import { isHtmlFile } from "shared/file-types";
import type { FileViewerMode } from "shared/tabs-types";
import { PaneToolbarActions } from "../../../components";
import type { SplitOrientation } from "../../../hooks";

interface FileViewerToolbarProps {
	fileName: string;
	filePath: string;
	isDirty: boolean;
	viewMode: FileViewerMode;
	/** If false, this is a preview pane (italic name, can be replaced) */
	isPinned: boolean;
	/** Show Rendered tab (for markdown/images) */
	hasRenderedMode: boolean;
	/** Show Changes tab (when file has diff) */
	hasDiff: boolean;
	splitOrientation: SplitOrientation;
	diffViewMode: DiffViewMode;
	hideUnchangedRegions: boolean;
	onViewModeChange: (value: string) => void;
	onDiffViewModeChange: (mode: DiffViewMode) => void;
	onToggleHideUnchangedRegions: () => void;
	onSplitPane: (e: React.MouseEvent) => void;
	/** Pin this pane (convert from preview to permanent) */
	onPin: () => void;
	onClosePane: (e: React.MouseEvent) => void;
	onPopOut?: (e: React.MouseEvent) => void;
	htmlZoomLevel?: number;
	onHtmlZoomChange?: (level: number) => void;
	onHtmlRefresh?: () => void;
}

export function FileViewerToolbar({
	fileName,
	filePath,
	isDirty,
	viewMode,
	isPinned,
	hasRenderedMode,
	hasDiff,
	splitOrientation,
	diffViewMode,
	hideUnchangedRegions,
	onViewModeChange,
	onDiffViewModeChange,
	onToggleHideUnchangedRegions,
	onSplitPane,
	onPin,
	onClosePane,
	onPopOut,
	htmlZoomLevel = 0,
	onHtmlZoomChange,
	onHtmlRefresh,
}: FileViewerToolbarProps) {
	const { copyToClipboard, copied } = useCopyToClipboard(1500);

	const ZOOM_STEP = 1;
	const ZOOM_MIN = -3;
	const ZOOM_MAX = 5;
	const zoomPercent = useMemo(
		() => Math.round(1.2 ** htmlZoomLevel * 100),
		[htmlZoomLevel],
	);
	const isHtml = isHtmlFile(filePath);
	const showHtmlZoom = viewMode === "rendered" && isHtml && onHtmlZoomChange;

	const applyZoom = useCallback(
		(level: number) => {
			const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
			onHtmlZoomChange?.(clamped);
		},
		[onHtmlZoomChange],
	);

	const handleCopyPath = () => {
		copyToClipboard(filePath);
	};
	return (
		<div className="flex h-full w-full items-center justify-between px-3">
			<div className="flex min-w-0 items-center gap-2">
				<Tooltip open={copied ? true : undefined}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleCopyPath}
							className={cn(
								"truncate text-xs text-muted-foreground hover:text-foreground transition-colors text-left",
								!isPinned && "italic",
							)}
						>
							{isDirty && <span className="text-amber-500 mr-1">●</span>}
							{fileName}
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						{copied ? "Copied!" : "Click to copy path"}
					</TooltipContent>
				</Tooltip>
			</div>
			<div className="flex items-center gap-1">
				<ToggleGroup
					type="single"
					value={viewMode}
					onValueChange={onViewModeChange}
					size="sm"
					className="h-5 bg-muted/50 rounded-md"
				>
					{hasRenderedMode && (
						<ToggleGroupItem
							value="rendered"
							className="h-5 px-1.5 text-[10px] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
						>
							Rendered
						</ToggleGroupItem>
					)}
					<ToggleGroupItem
						value="raw"
						className="h-5 px-1.5 text-[10px] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
					>
						Raw
					</ToggleGroupItem>
					{hasDiff && (
						<ToggleGroupItem
							value="diff"
							className="h-5 px-1.5 text-[10px] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
						>
							Changes
						</ToggleGroupItem>
					)}
				</ToggleGroup>
				{viewMode === "diff" && (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() =>
										onDiffViewModeChange(
											diffViewMode === "side-by-side"
												? "inline"
												: "side-by-side",
										)
									}
									className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
								>
									{diffViewMode === "side-by-side" ? (
										<TbLayoutSidebarRightFilled className="size-3.5" />
									) : (
										<TbListDetails className="size-3.5" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{diffViewMode === "side-by-side"
									? "Switch to inline diff"
									: "Switch to side by side diff"}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={onToggleHideUnchangedRegions}
									className={cn(
										"rounded p-0.5 transition-colors hover:text-muted-foreground",
										hideUnchangedRegions
											? "text-foreground"
											: "text-muted-foreground/60",
									)}
								>
									<TbFold className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{hideUnchangedRegions
									? "Show all lines"
									: "Hide unchanged regions"}
							</TooltipContent>
						</Tooltip>
					</>
				)}
				{showHtmlZoom && onHtmlRefresh && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onHtmlRefresh}
								aria-label="Refresh Preview"
								className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
							>
								<LuRefreshCw className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							Refresh Preview
						</TooltipContent>
					</Tooltip>
				)}
				{showHtmlZoom && (
					<div className="flex items-center gap-0.5">
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => applyZoom(htmlZoomLevel - ZOOM_STEP)}
									disabled={htmlZoomLevel <= ZOOM_MIN}
									className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:opacity-30"
								>
									<LuMinus className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								Zoom Out
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => applyZoom(0)}
									className="rounded px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground/60 transition-colors hover:text-muted-foreground"
								>
									{zoomPercent}%
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								Reset Zoom
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => applyZoom(htmlZoomLevel + ZOOM_STEP)}
									disabled={htmlZoomLevel >= ZOOM_MAX}
									className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:opacity-30"
								>
									<LuPlus className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								Zoom In
							</TooltipContent>
						</Tooltip>
					</div>
				)}
				<PaneToolbarActions
					splitOrientation={splitOrientation}
					onSplitPane={onSplitPane}
					onClosePane={onClosePane}
					onPopOut={onPopOut}
					leadingActions={
						!isPinned ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={onPin}
										className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
									>
										<TbPinFilled className="size-3" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom" showArrow={false}>
									Pin (keep open)
								</TooltipContent>
							</Tooltip>
						) : null
					}
				/>
			</div>
		</div>
	);
}
