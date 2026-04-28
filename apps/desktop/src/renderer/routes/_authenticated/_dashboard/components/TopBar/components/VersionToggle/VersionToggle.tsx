import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useV2LocalOverrideStore } from "renderer/stores/v2-local-override";

export function VersionToggle() {
	const { optInV2, toggle } = useV2LocalOverrideStore();
	const activeVersion = optInV2 ? "v2" : "v1";

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={toggle}
					className="no-drag flex items-center h-6 rounded-full bg-muted border border-border text-[11px] font-medium overflow-hidden transition-colors"
				>
					<span
						className={cn(
							"px-2 py-0.5 rounded-full transition-colors",
							activeVersion === "v1"
								? "bg-foreground text-background-solid"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						v1
					</span>
					<span
						className={cn(
							"px-2 py-0.5 rounded-full transition-colors",
							activeVersion === "v2"
								? "bg-foreground text-background-solid"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						v2
					</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>
				{optInV2
					? "Switch to Superset V1"
					: "Early Access: Switch to Superset V2"}
			</TooltipContent>
		</Tooltip>
	);
}
