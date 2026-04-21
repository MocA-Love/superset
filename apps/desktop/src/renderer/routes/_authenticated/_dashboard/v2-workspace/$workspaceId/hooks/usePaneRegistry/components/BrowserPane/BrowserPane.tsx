import type { RendererContext, Tab } from "@superset/panes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { TbDeviceDesktop } from "react-icons/tb";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { BrowserPaneData, PaneViewerData } from "../../../../types";

import { browserRuntimeRegistry } from "./browserRuntimeRegistry";
import { BrowserErrorOverlay } from "./components/BrowserErrorOverlay";
import { BrowserOverflowMenu } from "./components/BrowserOverflowMenu";
import { BrowserTabBar } from "./components/BrowserTabBar";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { usePersistentWebview } from "./hooks/usePersistentWebview";

function getSingleBrowserPane(
	tab: Tab<PaneViewerData>,
): { id: string; data: BrowserPaneData } | null {
	const paneIds = Object.keys(tab.panes);
	if (paneIds.length !== 1) return null;
	const pane = tab.panes[paneIds[0]];
	if (pane.kind !== "browser") return null;
	return { id: pane.id, data: pane.data as BrowserPaneData };
}

export function renderBrowserTabIcon(tab: Tab<PaneViewerData>) {
	const browser = getSingleBrowserPane(tab);
	if (!browser?.data.faviconUrl) return null;
	return (
		<img src={browser.data.faviconUrl} alt="" className="size-3.5 shrink-0" />
	);
}

interface BrowserPaneProps {
	ctx: RendererContext<PaneViewerData>;
}

function useBrowserState(paneId: string) {
	return useSyncExternalStore(
		useCallback(
			(cb) => browserRuntimeRegistry.onStateChange(paneId, cb),
			[paneId],
		),
		useCallback(() => browserRuntimeRegistry.getState(paneId), [paneId]),
	);
}

export function BrowserPane({ ctx }: BrowserPaneProps) {
	const paneId = ctx.pane.id;
	const state = useBrowserState(paneId);
	const { placeholderRef, reload } = usePersistentWebview({ paneId, ctx });

	// External CDP MCPs (chrome-devtools-mcp / browser-use) issue
	// `Target.createTarget` to open a new tab; the gateway's filter
	// forwards that intent to us as a create-tab-requested event so we
	// can spawn a real <webview> under the same pane.
	useEffect(() => {
		const sub = electronTrpcClient.browser.onCreateTabRequested.subscribe(
			{ paneId },
			{
				onData: (evt) => {
					const tabId = browserRuntimeRegistry.createTab(paneId, evt.url, {
						background: evt.background === true,
					});
					if (tabId && evt.requestId) {
						electronTrpcClient.browser.acknowledgeTabCreated
							.mutate({ paneId, requestId: evt.requestId, tabId })
							.catch(() => {});
					}
				},
				onError: () => {
					/* subscription errors surface in console */
				},
			},
		);
		return () => sub.unsubscribe();
	}, [paneId]);

	// Mirror MCP-driven tab activation (Target.activateTarget /
	// Page.bringToFront) onto the pane's tab bar.
	useEffect(() => {
		const sub = electronTrpcClient.browser.onActivateTabRequested.subscribe(
			{ paneId },
			{
				onData: (evt) => {
					if (evt.tabId === null) {
						browserRuntimeRegistry.showPrimary?.(paneId);
					} else {
						browserRuntimeRegistry.activateTab?.(paneId, evt.tabId);
					}
				},
				onError: () => {
					/* subscription errors surface in console */
				},
			},
		);
		return () => sub.unsubscribe();
	}, [paneId]);

	const isBlankPage = !state.currentUrl || state.currentUrl === "about:blank";

	return (
		<div className="relative flex flex-col flex-1 h-full">
			<BrowserTabBar paneId={paneId} />
			<div
				ref={placeholderRef}
				className="w-full flex-1 min-h-0"
				style={{ flex: 1 }}
			/>
			{state.error && !state.isLoading && (
				<BrowserErrorOverlay error={state.error} onRetry={reload} />
			)}
			{isBlankPage && !state.isLoading && !state.error && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background pointer-events-none">
					<GlobeIcon className="size-10 text-muted-foreground/30" />
					<div className="text-center">
						<p className="text-sm font-medium text-muted-foreground/50">
							Browser
						</p>
						<p className="mt-1 text-xs text-muted-foreground/30">
							Enter a URL above, or instruct an agent to navigate
							<br />
							and use the browser
						</p>
					</div>
				</div>
			)}
		</div>
	);
}

interface BrowserPaneToolbarProps {
	ctx: RendererContext<PaneViewerData>;
}

export function BrowserPaneToolbar({ ctx }: BrowserPaneToolbarProps) {
	const paneId = ctx.pane.id;
	const state = useBrowserState(paneId);

	const handleOpenDevTools = useCallback(() => {
		electronTrpcClient.browser.openDevTools.mutate({ paneId }).catch(() => {});
	}, [paneId]);

	const handleGoBack = useCallback(() => {
		browserRuntimeRegistry.goBack(paneId);
	}, [paneId]);

	const handleGoForward = useCallback(() => {
		browserRuntimeRegistry.goForward(paneId);
	}, [paneId]);

	const handleReload = useCallback(() => {
		browserRuntimeRegistry.reload(paneId);
	}, [paneId]);

	const handleNavigate = useCallback(
		(url: string) => {
			browserRuntimeRegistry.navigate(paneId, url);
		},
		[paneId],
	);

	const isBlankPage = !state.currentUrl || state.currentUrl === "about:blank";
	const PaneHeaderActions = ctx.components.PaneHeaderActions;

	return (
		<div className="flex h-full w-full items-center justify-between min-w-0">
			<BrowserToolbar
				currentUrl={state.currentUrl}
				pageTitle={state.pageTitle}
				isLoading={state.isLoading}
				canGoBack={state.canGoBack}
				canGoForward={state.canGoForward}
				onGoBack={handleGoBack}
				onGoForward={handleGoForward}
				onReload={handleReload}
				onNavigate={handleNavigate}
			/>
			<div className="flex items-center shrink-0 pr-1">
				<div className="mx-1.5 h-3.5 w-px bg-muted-foreground/60" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleOpenDevTools}
							className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
						>
							<TbDeviceDesktop className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Open DevTools
					</TooltipContent>
				</Tooltip>
				<BrowserOverflowMenu
					paneId={paneId}
					currentUrl={state.currentUrl}
					hasPage={!isBlankPage}
				/>
				<div className="mx-1 h-3.5 w-px bg-muted-foreground/60" />
				<PaneHeaderActions />
			</div>
		</div>
	);
}
