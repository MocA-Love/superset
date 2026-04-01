import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { GlobeIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { TbDeviceDesktop } from "react-icons/tb";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	normalizeBookmarkUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { SplitPaneOptions } from "renderer/stores/tabs/types";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { BookmarkBar } from "./components/BookmarkBar";
import { BrowserErrorOverlay } from "./components/BrowserErrorOverlay";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { BrowserOverflowMenu } from "./components/BrowserToolbar/components/BrowserOverflowMenu";
import { ExtensionToolbar } from "./components/ExtensionToolbar";
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
		options?: SplitPaneOptions,
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
}

export function BrowserPane({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: BrowserPaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const browserState = pane?.browser;
	const currentUrl = browserState?.currentUrl ?? DEFAULT_BROWSER_URL;
	const pageTitle =
		browserState?.history[browserState.historyIndex]?.title ?? "";
	const currentFaviconUrl =
		browserState?.history[browserState.historyIndex]?.faviconUrl;
	const isLoading = browserState?.isLoading ?? false;
	const loadError = browserState?.error ?? null;
	const isBlankPage = currentUrl === "about:blank";
	const currentBookmark = useBrowserBookmarksStore((state) =>
		state.bookmarks.find(
			(bookmark) =>
				normalizeBookmarkUrl(bookmark.url) === normalizeBookmarkUrl(currentUrl),
		),
	);
	const toggleBookmark = useBrowserBookmarksStore(
		(state) => state.toggleBookmark,
	);
	const { mutate: openDevTools } =
		electronTrpc.browser.openDevTools.useMutation();
	const { mutate: setZoomLevel } =
		electronTrpc.browser.setZoomLevel.useMutation();

	const {
		containerRef,
		goBack,
		goForward,
		reload,
		navigateTo,
		canGoBack,
		canGoForward,
	} = usePersistentWebview({
		paneId,
		tabId,
		path,
		initialUrl: currentUrl,
		splitPaneAuto,
	});

	// -- Zoom (synced with Electron's built-in Cmd+/- zoom) -----------------

	const ZOOM_STEP = 1;
	const ZOOM_MIN = -3;
	const ZOOM_MAX = 5;

	const [zoomLevel, setZoomLevelLocal] = useState(0);
	const zoomPercent = Math.round(1.2 ** zoomLevel * 100);

	// Sync when Cmd+/- changes zoom from keyboard
	electronTrpc.browser.onZoomChanged.useSubscription(
		{ paneId },
		{
			onData: ({ zoomLevel: level }) => {
				setZoomLevelLocal(level);
			},
		},
	);

	const applyZoom = useCallback(
		(level: number) => {
			const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
			setZoomLevelLocal(clamped);
			setZoomLevel({ paneId, level: clamped });
		},
		[paneId, setZoomLevel],
	);

	const handleOpenDevTools = useCallback(() => {
		openDevTools({ paneId });
	}, [openDevTools, paneId]);

	const [isEditingUrl, setIsEditingUrl] = useState(false);
	const handleToggleBookmark = useCallback(() => {
		if (isBlankPage) return;
		toggleBookmark({
			url: currentUrl,
			title: pageTitle || currentUrl,
			faviconUrl: currentFaviconUrl,
		});
	}, [currentFaviconUrl, currentUrl, isBlankPage, pageTitle, toggleBookmark]);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			draggable={!isEditingUrl}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between min-w-0">
					<BrowserToolbar
						currentUrl={currentUrl}
						pageTitle={pageTitle}
						isLoading={isLoading}
						hasPage={!isBlankPage}
						isBookmarked={Boolean(currentBookmark)}
						canGoBack={canGoBack}
						canGoForward={canGoForward}
						onGoBack={goBack}
						onGoForward={goForward}
						onReload={reload}
						onNavigate={navigateTo}
						onToggleBookmark={handleToggleBookmark}
						onEditingChange={setIsEditingUrl}
					/>
					<div className="flex items-center shrink-0">
						<div className="mx-1.5 h-3.5 w-px bg-muted-foreground/60" />
						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							closeHotkeyId="CLOSE_TERMINAL"
							onPopOut={handlers.onPopOut}
							leadingActions={
								<>
									<div className="flex items-center gap-0.5">
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() => applyZoom(zoomLevel - ZOOM_STEP)}
													disabled={zoomLevel <= ZOOM_MIN}
													className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:opacity-30"
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
													onClick={() => applyZoom(0)}
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
													onClick={() => applyZoom(zoomLevel + ZOOM_STEP)}
													disabled={zoomLevel >= ZOOM_MAX}
													className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:opacity-30"
												>
													<LuPlus className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="bottom" showArrow={false}>
												Zoom In
											</TooltipContent>
										</Tooltip>
									</div>
									<ExtensionToolbar />
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
			<div className="flex h-full flex-1 flex-col">
				<BookmarkBar currentUrl={currentUrl} onNavigate={navigateTo} />
				<div className="relative flex flex-1 min-h-0">
					<div
						ref={containerRef}
						className="h-full w-full"
						style={{ flex: 1 }}
					/>
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
			</div>
		</BasePaneWindow>
	);
}
