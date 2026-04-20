import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPlug } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";

interface ConnectButtonProps {
	paneId: string;
}

export function ConnectButton({ paneId }: ConnectButtonProps) {
	// Use the centralized liveness query so every Connect button across
	// the window shares one fetch. React Query dedupes by key, and the
	// binding subscription in `useBrowserBindingsSync` drives
	// invalidation when another window mutates.
	const { data: liveness = [] } =
		electronTrpc.browserAutomation.listBindingLiveness.useQuery(undefined, {
			refetchOnWindowFocus: true,
			refetchInterval: 15000,
		});
	const openConnectModal = useBrowserAutomationStore((s) => s.openConnectModal);

	const entry = liveness.find((b) => b.paneId === paneId) ?? null;
	const hasBinding = Boolean(entry);
	const live = entry?.live ?? false;
	const connected = hasBinding && live;
	const stale = hasBinding && !live;
	const label = connected ? "Connected" : stale ? "Session ended" : "Connect";

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={() => openConnectModal(paneId, entry?.sessionId)}
					data-state={connected ? "connected" : stale ? "stale" : "idle"}
					className={`flex items-center gap-1.5 h-6 rounded-md px-2 text-[11px] border transition-colors ${
						connected
							? "border-brand/30 bg-brand/10 text-foreground hover:bg-brand/15"
							: stale
								? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15"
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
					: stale
						? "Bound session is no longer running — pick a new one"
						: "Connect this browser pane to a running LLM session"}
			</TooltipContent>
		</Tooltip>
	);
}
