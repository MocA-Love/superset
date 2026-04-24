import { cn } from "@superset/ui/utils";
import { X } from "lucide-react";
import { basename } from "../../utils/path";

export interface ScratchTab {
	id: string;
	absolutePath: string;
}

interface ScratchTabBarProps {
	tabs: ScratchTab[];
	activeTabId: string | null;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
}

export function ScratchTabBar({
	tabs,
	activeTabId,
	onSelect,
	onClose,
}: ScratchTabBarProps) {
	if (tabs.length === 0) return null;
	return (
		<div
			className="flex h-9 min-h-9 items-stretch overflow-x-auto border-border border-b bg-tertiary"
			role="tablist"
		>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				return (
					<div
						key={tab.id}
						className={cn(
							"flex items-center gap-1.5 border-border border-r px-3 text-xs",
							"text-muted-foreground hover:text-foreground",
							isActive && "bg-background text-foreground",
						)}
						title={tab.absolutePath}
					>
						<button
							type="button"
							role="tab"
							aria-selected={isActive}
							className="flex items-center gap-1.5 outline-none"
							onClick={() => onSelect(tab.id)}
						>
							<span className="max-w-52 truncate">
								{basename(tab.absolutePath)}
							</span>
							<span
								className="rounded bg-warn/10 px-1 py-px font-medium text-[10px] text-warn"
								title="Scratch tab (temporary)"
							>
								一時
							</span>
						</button>
						<button
							type="button"
							aria-label={`Close ${basename(tab.absolutePath)}`}
							className="ml-1 flex size-4 items-center justify-center rounded opacity-60 hover:bg-muted hover:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								onClose(tab.id);
							}}
						>
							<X className="size-3" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
