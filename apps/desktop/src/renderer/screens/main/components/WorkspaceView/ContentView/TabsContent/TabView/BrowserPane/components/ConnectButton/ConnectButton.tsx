import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPlug } from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";

interface ConnectButtonProps {
	paneId: string;
}

export function ConnectButton({ paneId }: ConnectButtonProps) {
	// Do not fetch the session list / MCP status here; those are only
	// needed inside the Connect dialog. The binding query is cheap and
	// subscription-driven, so the badge still reflects connect/disconnect
	// in real time.
	const { bindingsByPane } = useBrowserAutomationData({ enabled: false });
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);

	const sessionId = bindingsByPane[paneId];
	const connected = Boolean(sessionId);
	const label = connected ? "Connected" : "Connect";

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={() => openConnectModal(paneId, sessionId)}
					data-state={connected ? "connected" : "idle"}
					className={`flex items-center gap-1.5 h-6 rounded-md px-2 text-[11px] border transition-colors ${
						connected
							? "border-brand/30 bg-brand/10 text-foreground hover:bg-brand/15"
							: "border-border bg-muted/40 text-muted-foreground/90 hover:bg-muted/70"
					}`}
				>
					<LuPlug className="size-3" />
					<span className="max-w-[180px] truncate">{label}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				{connected
					? "Change or disconnect browser automation session"
					: "Connect this browser pane to a running LLM session"}
			</TooltipContent>
		</Tooltip>
	);
}
