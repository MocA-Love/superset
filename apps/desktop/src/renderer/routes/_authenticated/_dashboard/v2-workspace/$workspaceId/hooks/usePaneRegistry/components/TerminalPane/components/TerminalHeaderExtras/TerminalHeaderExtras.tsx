import type { RendererContext } from "@superset/panes";
import type { PaneViewerData } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";

interface TerminalHeaderExtrasProps {
	context: RendererContext<PaneViewerData>;
}

export function TerminalHeaderExtras({ context }: TerminalHeaderExtrasProps) {
	if (context.pane.kind !== "terminal") return null;
	return null;
}
