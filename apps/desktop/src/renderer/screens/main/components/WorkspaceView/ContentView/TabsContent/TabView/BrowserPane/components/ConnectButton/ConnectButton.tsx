import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPlug } from "react-icons/lu";
import { useBrowserAutomationData } from "renderer/hooks/useBrowserAutomationData";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";

interface ConnectButtonProps {
	paneId: string;
}

export function ConnectButton({ paneId }: ConnectButtonProps) {
	const { sessions, bindingsByPane } = useBrowserAutomationData();
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);

	const sessionId = bindingsByPane[paneId];
	const session = sessionId
		? (sessions.find((s) => s.id === sessionId) ?? null)
		: null;
	const connected = Boolean(session);
	const label = connected
		? `${session?.displayName} · ${session?.provider}`
		: "Connect";

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
