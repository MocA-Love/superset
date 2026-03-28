import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { GlobeIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { TbDeviceDesktop } from "react-icons/tb";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { BrowserErrorOverlay } from "./components/BrowserErrorOverlay";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { BrowserOverflowMenu } from "./components/BrowserToolbar/components/BrowserOverflowMenu";
import { DEFAULT_BROWSER_URL } from "./constants";
import { usePersistentWebview } from "./hooks/usePersistentWebview";

interface BrowserPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
}

export function BrowserPane({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
}: BrowserPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const browserState = pane?.browser;
	const currentUrl = browserState?.currentUrl ?? DEFAULT_BROWSER_URL;
	const pageTitle =
		browserState?.history[browserState.historyIndex]?.title ?? "";
	const isLoading = browserState?.isLoading ?? false;
	const loadError = browserState?.error ?? null;
	const isBlankPage = currentUrl === "about:blank";
	const { mutate: openDevTools } =
		electronTrpc.browser.openDevTools.useMutation();

	const {
		containerRef,
		goBack,
		goForward,
		reload,
		navigateTo,
		canGoBack,
		canGoForward,
		setGuestZoom,
	} = usePersistentWebview({
		paneId,
		initialUrl: currentUrl,
	});

	// -- Zoom state (CSS zoom injected into guest page) ---------------------

	const ZOOM_STEP = 10;
	const ZOOM_MIN = 50;
	const ZOOM_MAX = 200;

	const [zoomPercent, setZoomPercent] = useState(100);

	const applyZoom = useCallback(
		(percent: number) => {
			setZoomPercent(percent);
			setGuestZoom(percent / 100);
		},
		[setGuestZoom],
	);

	const zoomIn = useCallback(
		() => applyZoom(Math.min(ZOOM_MAX, zoomPercent + ZOOM_STEP)),
		[applyZoom, zoomPercent],
	);
	const zoomOut = useCallback(
		() => applyZoom(Math.max(ZOOM_MIN, zoomPercent - ZOOM_STEP)),
		[applyZoom, zoomPercent],
	);
	const resetZoom = useCallback(() => applyZoom(100), [applyZoom]);

	const handleOpenDevTools = useCallback(() => {
		openDevTools({ paneId });
	}, [openDevTools, paneId]);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between min-w-0">
					<BrowserToolbar
						currentUrl={currentUrl}
						pageTitle={pageTitle}
						isLoading={isLoading}
						canGoBack={canGoBack}
						canGoForward={canGoForward}
						onGoBack={goBack}
						onGoForward={goForward}
						onReload={reload}
						onNavigate={navigateTo}
					/>
					<div className="flex items-center shrink-0">
						<div className="mx-1.5 h-3.5 w-px bg-muted-foreground/60" />
						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							closeHotkeyId="CLOSE_TERMINAL"
							leadingActions={
								<>
									<div className="flex items-center gap-0.5">
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={zoomOut}
													className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
												>
													<LuMinus className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom" showArrow={false}>
												Zoom Out
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={resetZoom}
													className="rounded px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground/60 transition-colors hover:text-muted-foreground"
												>
													{zoomPercent}%
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom" showArrow={false}>
												Reset Zoom
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={zoomIn}
													className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
												>
													<LuPlus className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom" showArrow={false}>
												Zoom In
											</TooltipContent>
										</Tooltip>
									</div>
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
									<BrowserOverflowMenu paneId={paneId} hasPage={!isBlankPage} />
								</>
							}
						/>
					</div>
				</div>
			)}
		>
			<div className="relative flex flex-1 h-full">
				<div ref={containerRef} className="w-full h-full" style={{ flex: 1 }} />
				{loadError && !isLoading && (
					<BrowserErrorOverlay error={loadError} onRetry={reload} />
				)}
				{isBlankPage && !isLoading && !loadError && (
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
		</BasePaneWindow>
	);
}
