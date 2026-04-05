import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import type { ReactNode } from "react";

export interface RowHoverAction {
	key: string;
	label: string;
	icon: ReactNode;
	onClick: () => void;
	isDestructive?: boolean;
	disabled?: boolean;
}

interface RowHoverActionsProps {
	actions: RowHoverAction[];
}

export function RowHoverActions({ actions }: RowHoverActionsProps) {
	if (actions.length === 0) {
		return null;
	}

	return (
		<div className="flex items-center gap-0.5 shrink-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto group-hover:bg-accent group-focus-within:bg-accent rounded-sm">
			{actions.map((action) => (
				<Tooltip key={action.key} delayDuration={500}>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className={cn(
								"size-5 hover:bg-accent",
								action.isDestructive && "hover:text-destructive",
							)}
							onClick={(e) => {
								e.stopPropagation();
								action.onClick();
							}}
							disabled={action.disabled}
						>
							{action.icon}
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{action.label}</TooltipContent>
				</Tooltip>
			))}
		</div>
	);
}
