import { Button } from "@superset/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useMemo, useState } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { LuListChecks, LuListMinus, LuPalette, LuTrash2 } from "react-icons/lu";
import { ColorSelector } from "renderer/components/ColorSelector/ColorSelector";
import { requestTabClose } from "renderer/stores/editor-state/editorCoordinator";
import { useTabBulkSelectionStore } from "renderer/stores/tab-bulk-selection-store";
import { useTabsStore } from "renderer/stores/tabs/store";
import { PROJECT_COLOR_DEFAULT } from "shared/constants/project-colors";

interface BulkActionBarProps {
	workspaceId: string;
}

export function BulkActionBar({ workspaceId }: BulkActionBarProps) {
	const bulkWorkspaceId = useTabBulkSelectionStore((s) => s.workspaceId);
	const selectedTabIds = useTabBulkSelectionStore((s) => s.selectedTabIds);
	const exitBulkMode = useTabBulkSelectionStore((s) => s.exitBulkMode);
	const setSelection = useTabBulkSelectionStore((s) => s.setSelection);
	const allTabs = useTabsStore((s) => s.tabs);
	const setTabColor = useTabsStore((s) => s.setTabColor);
	const [colorOpen, setColorOpen] = useState(false);

	const workspaceTabIds = useMemo(
		() =>
			allTabs
				.filter((tab) => tab.workspaceId === workspaceId)
				.map((tab) => tab.id),
		[allTabs, workspaceId],
	);

	if (bulkWorkspaceId !== workspaceId) {
		return null;
	}

	const selectedCount = selectedTabIds.size;
	const allSelected =
		workspaceTabIds.length > 0 && selectedCount === workspaceTabIds.length;

	const handleSelectAll = () => {
		setSelection(workspaceTabIds);
	};

	const handleInvert = () => {
		const inverted = workspaceTabIds.filter((id) => !selectedTabIds.has(id));
		setSelection(inverted);
	};

	const handleApplyColor = (color: string) => {
		const resolvedColor = color === PROJECT_COLOR_DEFAULT ? null : color;
		for (const tabId of selectedTabIds) {
			setTabColor(tabId, resolvedColor);
		}
		setColorOpen(false);
	};

	const handleBulkClose = () => {
		const ids = Array.from(selectedTabIds);
		for (const tabId of ids) {
			requestTabClose(tabId);
		}
		exitBulkMode();
	};

	return (
		<div className="flex h-9 items-center gap-2 border-b border-border bg-muted/30 px-3">
			<Tooltip delayDuration={400}>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="Exit selection mode"
						onClick={exitBulkMode}
					>
						<HiMiniXMark className="size-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">Exit selection mode</TooltipContent>
			</Tooltip>
			<span className="text-xs text-muted-foreground">
				{selectedCount} selected
			</span>
			<div className="ml-2 flex items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={handleSelectAll}
					disabled={allSelected}
				>
					<LuListChecks className="size-3.5 mr-1.5" />
					Select all
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={handleInvert}
					disabled={workspaceTabIds.length === 0}
				>
					<LuListMinus className="size-3.5 mr-1.5" />
					Invert
				</Button>
			</div>
			<div className="ml-auto flex items-center gap-2">
				<Popover open={colorOpen} onOpenChange={setColorOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							className="h-7 px-2 text-xs"
							disabled={selectedCount === 0}
						>
							<LuPalette className="size-3.5 mr-1.5" />
							Set color
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-auto p-3" align="end">
						<div className="mb-2 text-xs text-muted-foreground">
							Apply color to {selectedCount} tab
							{selectedCount === 1 ? "" : "s"}
						</div>
						<ColorSelector variant="inline" onSelectColor={handleApplyColor} />
					</PopoverContent>
				</Popover>
				<Button
					variant="destructive"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={handleBulkClose}
					disabled={selectedCount === 0}
				>
					<LuTrash2 className="size-3.5 mr-1.5" />
					Close selected
				</Button>
			</div>
		</div>
	);
}
