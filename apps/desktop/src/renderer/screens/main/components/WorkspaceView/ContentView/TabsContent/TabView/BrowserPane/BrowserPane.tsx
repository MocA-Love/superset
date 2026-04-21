import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { TbDeviceDesktop } from "react-icons/tb";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";
import {
	findBookmarkByUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { useBrowserFullscreenStore } from "renderer/stores/browser-fullscreen";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { SplitPaneOptions } from "renderer/stores/tabs/types";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { BookmarkBar } from "./components/BookmarkBar";
import { BrowserErrorOverlay } from "./components/BrowserErrorOverlay";
import {
	BrowserFindOverlay,
	type BrowserFindOverlayHandle,
} from "./components/BrowserFindOverlay";
import { BrowserTabBar } from "./components/BrowserTabBar";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { BrowserOverflowMenu } from "./components/BrowserToolbar/components/BrowserOverflowMenu";
import { ConnectButton } from "./components/ConnectButton";
import { ExtensionToolbar } from "./components/ExtensionToolbar";
import { SessionConnectModal } from "./components/SessionConnectModal";
import { DEFAULT_BROWSER_URL } from "./constants";
import { usePersistentWebview } from "./hooks/usePersistentWebview";
import { secondaryTabRegistry } from "./hooks/useSecondaryTabs";

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
	const bookmarks = useBrowserBookmarksStore((state) => state.bookmarks);
	const currentBookmark = useMemo(
		() => findBookmarkByUrl(bookmarks, currentUrl),
		[bookmarks, currentUrl],
	);
	const toggleBookmark = useBrowserBookmarksStore(
		(state) => state.toggleBookmark,
	);
	const syncBookmarkFaviconByUrl = useBrowserBookmarksStore(
		(state) => state.syncBookmarkFaviconByUrl,
	);
	const isFullscreen = useBrowserFullscreenStore(
		(s) => s.fullscreenPaneId === paneId,
	);
	// Narrow the subscription so BrowserPane (and its webview tree) does not
	// re-render every time the modal's selectedSessionId changes.
	const isConnectOpenForThisPane = useBrowserAutomationStore(
		(s) => s.connectModal.isOpen && s.connectModal.paneId === paneId,
	);
	const closeConnectModal = useBrowserAutomationStore(
		(s) => s.closeConnectModal,
	);
	const { mutate: openDevTools } =
		electronTrpc.browser.openDevTools.useMutation();
	const { mutate: setZoomLevel } =
		electronTrpc.browser.setZoomLevel.useMutation();
	const { mutate: findInPage } = electronTrpc.browser.findInPage.useMutation();
	const { mutate: stopFindInPage } =
		electronTrpc.browser.stopFindInPage.useMutation();

	// -- Find in page ------------------------------------------------------

	const [isFindOpen, setIsFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findMatchCase, setFindMatchCase] = useState(false);
	const [findMatches, setFindMatches] = useState(0);
	const [findActiveOrdinal, setFindActiveOrdinal] = useState(0);
	const findOverlayRef = useRef<BrowserFindOverlayHandle | null>(null);

	const openFindOverlay = useCallback(() => {
		setIsFindOpen(true);
		// Refocus + select even if already open (repeat Cmd+F).
		findOverlayRef.current?.focusInput();
	}, []);

	const closeFindOverlay = useCallback(() => {
		setIsFindOpen(false);
		setFindMatches(0);
		setFindActiveOrdinal(0);
		stopFindInPage({ paneId, action: "clearSelection" });
	}, [paneId, stopFindInPage]);

	const runFindQuery = useCallback(
		(
			text: string,
			opts?: { findNext?: boolean; forward?: boolean; matchCase?: boolean },
		) => {
			if (!text) {
				setFindMatches(0);
				setFindActiveOrdinal(0);
				stopFindInPage({ paneId, action: "clearSelection" });
				return;
			}
			findInPage({
				paneId,
				text,
				forward: opts?.forward ?? true,
				findNext: opts?.findNext ?? false,
				matchCase: opts?.matchCase ?? findMatchCase,
			});
		},
		[findInPage, findMatchCase, paneId, stopFindInPage],
	);

	const handleFindQueryChange = useCallback(
		(next: string) => {
			setFindQuery(next);
			runFindQuery(next, { findNext: false, forward: true });
		},
		[runFindQuery],
	);

	const handleFindNext = useCallback(() => {
		if (!findQuery) return;
		runFindQuery(findQuery, { findNext: true, forward: true });
	}, [findQuery, runFindQuery]);

	const handleFindPrevious = useCallback(() => {
		if (!findQuery) return;
		runFindQuery(findQuery, { findNext: true, forward: false });
	}, [findQuery, runFindQuery]);

	const handleMatchCaseChange = useCallback(
		(next: boolean) => {
			setFindMatchCase(next);
			if (findQuery) {
				runFindQuery(findQuery, {
					findNext: false,
					forward: true,
					matchCase: next,
				});
			}
		},
		[findQuery, runFindQuery],
	);

	electronTrpc.browser.onFindRequested.useSubscription(
		{ paneId },
		{
			onData: (event) => {
				if (event.type === "open") {
					openFindOverlay();
				} else if (event.type === "escape") {
					if (isFindOpen) closeFindOverlay();
				}
			},
		},
	);

	electronTrpc.browser.onFoundInPage.useSubscription(
		{ paneId },
		{
			onData: (result) => {
				setFindMatches(result.matches);
				setFindActiveOrdinal(result.activeMatchOrdinal);
			},
		},
	);

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

	// -- Secondary tabs -----------------------------------------------------
	//
	// v1's primary webview lives in usePersistentWebview + tabs-store. This
	// BrowserPane also hosts a secondary tab registry for anything beyond
	// the primary (user-opened via the overflow menu, or CDP-opened via an
	// external MCP's Target.createTarget). When a secondary tab is active,
	// we hide the primary webview via CSS and the secondary registry
	// overlays its own webview atop the same placeholder (containerRef).

	const [activeTabId, setActiveTabId] = useState("primary");
	const secondaryContainerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = secondaryContainerRef.current;
		if (!el) return;
		secondaryTabRegistry.attach(paneId, el);
		return () => secondaryTabRegistry.detach(paneId);
	}, [paneId]);

	useEffect(() => {
		return () => secondaryTabRegistry.destroy(paneId);
	}, [paneId]);

	useEffect(() => {
		// We never CSS-hide the primary — that would put its
		// underlying webContents into Chromium's page-lifecycle
		// "hidden" state, which causes external CDP MCPs to appear to
		// hang on sites that pause work while hidden. The active
		// secondary tab simply z-index-overlays the primary; when
		// activeTabId === "primary" we just hide all secondaries.
		if (activeTabId === "primary") {
			secondaryTabRegistry.setVisible(paneId, false);
		} else {
			secondaryTabRegistry.activateTab(paneId, activeTabId);
			secondaryTabRegistry.setVisible(paneId, true);
		}
	}, [activeTabId, paneId]);

	// External CDP MCPs issue Target.createTarget → bridge emits
	// create-tab-requested on the pane. Spawn a real secondary tab so
	// the gateway's bound-set picks up the new targetId.
	const { mutate: ackTabCreated } =
		electronTrpc.browser.acknowledgeTabCreated.useMutation();

	electronTrpc.browser.onCreateTabRequested.useSubscription(
		{ paneId },
		{
			onData: (evt) => {
				console.log(
					"[BrowserPane v1] create-tab-requested url=",
					evt.url,
					"pane=",
					paneId,
					"req=",
					evt.requestId,
					"bg=",
					evt.background,
				);
				const tabId = secondaryTabRegistry.createTab(paneId, evt.url, {
					background: evt.background === true,
				});
				console.log(
					"[BrowserPane v1] secondaryTabRegistry.createTab returned tabId=",
					tabId,
				);
				if (tabId) {
					if (!evt.background) setActiveTabId(tabId);
					if (evt.requestId) {
						ackTabCreated({ paneId, requestId: evt.requestId, tabId });
					}
				}
			},
		},
	);

	// MCP may flip tabs via Target.activateTarget / Page.bringToFront.
	// Mirror that into the BrowserPane's tab bar so what the MCP drives
	// matches what the user sees (Chrome's tab strip follows CDP).
	electronTrpc.browser.onActivateTabRequested.useSubscription(
		{ paneId },
		{
			onData: (evt) => {
				if (evt.tabId === null) {
					secondaryTabRegistry.showPrimary(paneId);
					setActiveTabId(null);
				} else {
					secondaryTabRegistry.activateTab(paneId, evt.tabId);
					setActiveTabId(evt.tabId);
				}
			},
		},
	);

	const [isEditingUrl, setIsEditingUrl] = useState(false);

	useEffect(() => {
		if (!currentBookmark || !currentFaviconUrl) {
			return;
		}
		if (currentBookmark.faviconUrl === currentFaviconUrl) {
			return;
		}
		syncBookmarkFaviconByUrl(currentUrl, currentFaviconUrl);
	}, [
		currentBookmark,
		currentFaviconUrl,
		currentUrl,
		syncBookmarkFaviconByUrl,
	]);

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
			hideToolbar={isFullscreen}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between min-w-0">
					<BrowserToolbar
						paneId={paneId}
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
									<ConnectButton paneId={paneId} />
									<div className="mx-1 h-3.5 w-px bg-muted-foreground/60" />
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
			<div
				className="flex h-full flex-1 flex-col"
				onKeyDownCapture={(event) => {
					if (
						(event.metaKey || event.ctrlKey) &&
						!event.altKey &&
						!event.shiftKey &&
						event.key.toLowerCase() === "f"
					) {
						event.preventDefault();
						event.stopPropagation();
						openFindOverlay();
					} else if (event.key === "Escape" && isFindOpen) {
						event.preventDefault();
						closeFindOverlay();
					}
				}}
			>
				{!isFullscreen && (
					<BookmarkBar currentUrl={currentUrl} onNavigate={navigateTo} />
				)}
				<BrowserTabBar
					paneId={paneId}
					primaryUrl={currentUrl}
					primaryTitle={pageTitle}
					primaryFaviconUrl={currentFaviconUrl ?? null}
					primaryIsLoading={isLoading}
					activeTabId={activeTabId}
					onActivate={setActiveTabId}
				/>
				<div className="relative flex flex-1 min-h-0">
					<div
						ref={containerRef}
						className="h-full w-full"
						style={{ flex: 1 }}
					/>
					<div
						ref={secondaryContainerRef}
						className="absolute inset-0 pointer-events-none"
					/>
					<BrowserFindOverlay
						ref={findOverlayRef}
						isOpen={isFindOpen}
						query={findQuery}
						matchCount={findMatches}
						activeMatchOrdinal={findActiveOrdinal}
						matchCase={findMatchCase}
						onQueryChange={handleFindQueryChange}
						onMatchCaseChange={handleMatchCaseChange}
						onFindNext={handleFindNext}
						onFindPrevious={handleFindPrevious}
						onClose={closeFindOverlay}
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
			<SessionConnectModal
				open={isConnectOpenForThisPane}
				onOpenChange={(open) => {
					if (!open) closeConnectModal();
				}}
			/>
		</BasePaneWindow>
	);
}
