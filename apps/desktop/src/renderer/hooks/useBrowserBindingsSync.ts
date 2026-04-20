import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Centralized binding subscription — mount ONCE per window (from
 * ContentView). Without this, every `useBrowserAutomationData` consumer
 * (one per browser pane) would open its own subscription to the main
 * process emitter and fan out an invalidation per binding mutation.
 */
export function useBrowserBindingsSync() {
	const utils = electronTrpc.useUtils();
	electronTrpc.browserAutomation.onBindingsChanged.useSubscription(undefined, {
		onData: () => {
			utils.browserAutomation.listBindings.invalidate();
			utils.browserAutomation.listBindingLiveness.invalidate();
		},
	});
}
