import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import type { ReactNode } from "react";
import { VscListFlat, VscListSelection, VscListTree } from "react-icons/vsc";
import type { ChangesViewMode } from "../../types";

interface ViewModeToggleProps {
	viewMode: ChangesViewMode;
	onViewModeChange: (mode: ChangesViewMode) => void;
}

export function ViewModeToggle({
	viewMode,
	onViewModeChange,
}: ViewModeToggleProps) {
	const modeOrder: ChangesViewMode[] = ["grouped", "compact", "tree"];
	const currentIndex = modeOrder.indexOf(viewMode);
	const nextMode = modeOrder[(currentIndex + 1) % modeOrder.length] ?? "grouped";

	const nextModeMeta: Record<
		ChangesViewMode,
		{ label: string; icon: ReactNode }
	> = {
		grouped: {
			label: "Switch to grouped view",
			icon: <VscListFlat className="size-3.5" />,
		},
		compact: {
			label: "Switch to compact view",
			icon: <VscListSelection className="size-3.5" />,
		},
		tree: {
			label: "Switch to tree view",
			icon: <VscListTree className="size-3.5" />,
		},
	};

	const handleToggle = () => {
		onViewModeChange(nextMode);
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={handleToggle}
					className="size-6 p-0"
					aria-label={nextModeMeta[nextMode].label}
				>
					{nextModeMeta[nextMode].icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top" showArrow={false}>
				{nextModeMeta[nextMode].label}
			</TooltipContent>
		</Tooltip>
	);
}
