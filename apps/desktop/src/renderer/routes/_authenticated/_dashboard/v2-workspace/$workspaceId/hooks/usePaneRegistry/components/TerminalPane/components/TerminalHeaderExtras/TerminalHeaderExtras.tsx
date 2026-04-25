import type { RendererContext } from "@superset/panes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { Archive } from "lucide-react";
import { markTerminalForBackground } from "renderer/lib/terminal/terminal-background-intents";
import type {
	PaneViewerData,
	TerminalPaneData,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";

interface TerminalHeaderExtrasProps {
	context: RendererContext<PaneViewerData>;
}

export function TerminalHeaderExtras({ context }: TerminalHeaderExtrasProps) {
	if (context.pane.kind !== "terminal") return null;

	const data = context.pane.data as TerminalPaneData;

	const handleMoveToBackground = () => {
		// Check whether other panes sharing the same terminalId still exist.
		// If so, only close this pane without marking the background intent —
		// the stale intent would otherwise cause the remaining pane's eventual
		// close to skip dispose/killSession (silent PTY leak).
		const state = context.store.getState();
		const duplicateExists = state.tabs.some((tab) =>
			Object.values(tab.panes).some(
				(pane) =>
					pane.id !== context.pane.id &&
					pane.kind === "terminal" &&
					(pane.data as TerminalPaneData).terminalId === data.terminalId,
			),
		);

		if (!duplicateExists) {
			markTerminalForBackground(data.terminalId);
		}
		void context.actions.close();
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label="Move terminal to background"
					onClick={(event) => {
						event.stopPropagation();
						handleMoveToBackground();
					}}
					className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
				>
					<Archive className="size-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				Move terminal to background
			</TooltipContent>
		</Tooltip>
	);
}
