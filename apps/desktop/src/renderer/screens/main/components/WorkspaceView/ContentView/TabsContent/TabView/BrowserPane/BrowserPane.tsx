import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { BrowserPaneChrome } from "../components/BrowserPaneChrome";
import type { BrowserFindOverlayHandle } from "./components/BrowserFindOverlay";
import { BrowserOverflowMenu } from "./components/BrowserToolbar/components/BrowserOverflowMenu";
import { DEFAULT_BROWSER_URL } from "./constants";
import { usePersistentWebview } from "./hooks/usePersistentWebview";
import { getPersistentWrapper } from "./hooks/usePersistentWebview/runtime";
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
	const isFullscreen = useBrowserFullscreenStore(
		(s) => s.fullscreenPaneId === paneId,
	);

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

	const [isFindOpen, setIsFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findMatchCase, setFindMatchCase] = useState(false);
	const [findMatches, setFindMatches] = useState(0);
	const [findActiveOrdinal, setFindActiveOrdinal] = useState(0);
	const findOverlayRef = useRef<BrowserFindOverlayHandle | null>(null);

	const openFindOverlay = useCallback(() => {
		setIsFindOpen(true);
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
				} else if (event.type === "escape" && isFindOpen) {
					closeFindOverlay();
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

	const ZOOM_STEP = 1;
	const ZOOM_MIN = -3;
	const ZOOM_MAX = 5;
	const [zoomLevel, setZoomLevelLocal] = useState(0);

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

	const [activeTabId, setActiveTabId] = useState("primary");
	const secondaryContainerRef = useRef<HTMLDivElement | null>(null);

	const secondaryTabs = useSyncExternalStore(
		useCallback(
			(cb) => secondaryTabRegistry.onTabsChange(paneId, cb),
			[paneId],
		),
		useCallback(() => secondaryTabRegistry.listTabs(paneId), [paneId]),
	);
	const activeSecondary =
		activeTabId === "primary"
			? null
			: (secondaryTabs.find((t) => t.tabId === activeTabId) ?? null);

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
		const primaryWrapper = getPersistentWrapper(paneId);
		if (activeTabId === "primary") {
			secondaryTabRegistry.setVisible(paneId, false);
			if (primaryWrapper) {
				primaryWrapper.style.opacity = "1";
				primaryWrapper.style.pointerEvents = "auto";
			}
		} else {
			secondaryTabRegistry.activateTab(paneId, activeTabId);
			secondaryTabRegistry.setVisible(paneId, true);
			if (primaryWrapper) {
				primaryWrapper.style.opacity = "0";
				primaryWrapper.style.pointerEvents = "none";
			}
		}
	}, [activeTabId, paneId]);

	const { mutate: ackTabCreated } =
		electronTrpc.browser.acknowledgeTabCreated.useMutation();

	electronTrpc.browser.onCreateTabRequested.useSubscription(
		{ paneId },
		{
			onData: (evt) => {
				const nextTabId = secondaryTabRegistry.createTab(paneId, evt.url, {
					background: evt.background === true,
				});
				if (!nextTabId) return;
				if (!evt.background) {
					setActiveTabId(nextTabId);
				}
				if (evt.requestId) {
					ackTabCreated({ paneId, requestId: evt.requestId, tabId: nextTabId });
				}
			},
		},
	);

	electronTrpc.browser.onActivateTabRequested.useSubscription(
		{ paneId },
		{
			onData: (evt) => {
				if (evt.tabId === null) {
					secondaryTabRegistry.showPrimary(paneId);
					setActiveTabId("primary");
				} else {
					secondaryTabRegistry.activateTab(paneId, evt.tabId);
					setActiveTabId(evt.tabId);
				}
			},
		},
	);

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

	const displayedUrl = activeSecondary ? activeSecondary.url : currentUrl;
	const displayedTitle = activeSecondary ? activeSecondary.title : pageTitle;
	const displayedIsLoading = activeSecondary ? activeSecondary.isLoading : isLoading;
	const displayedHasPage = activeSecondary
		? Boolean(activeSecondary.url && activeSecondary.url !== "about:blank")
		: !isBlankPage;

	return (
		<BrowserPaneChrome
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			onPopOut={onPopOut}
			isFullscreen={isFullscreen}
			isConnectOpen={isConnectOpenForThisPane}
			onConnectOpenChange={(open) => {
				if (!open) closeConnectModal();
			}}
			currentUrl={displayedUrl}
			pageTitle={displayedTitle}
			isLoading={displayedIsLoading}
			isBlankPage={!displayedHasPage}
			loadError={loadError}
			isBookmarked={activeSecondary ? false : Boolean(currentBookmark)}
			canGoBack={activeSecondary ? true : canGoBack}
			canGoForward={activeSecondary ? true : canGoForward}
			onGoBack={
				activeSecondary
					? () => secondaryTabRegistry.goBackActive(paneId)
					: goBack
			}
			onGoForward={
				activeSecondary
					? () => secondaryTabRegistry.goForwardActive(paneId)
					: goForward
			}
			onReload={
				activeSecondary
					? () => secondaryTabRegistry.reloadActive(paneId)
					: reload
			}
			onNavigate={
				activeSecondary
					? (url: string) => secondaryTabRegistry.navigateActive(paneId, url)
					: navigateTo
			}
			onToggleBookmark={handleToggleBookmark}
			onOpenDevTools={handleOpenDevTools}
			zoomLevel={zoomLevel}
			onZoomChange={applyZoom}
			zoomStep={ZOOM_STEP}
			zoomMin={ZOOM_MIN}
			zoomMax={ZOOM_MAX}
			bookmarkBar={{
				currentUrl,
				onNavigate: navigateTo,
			}}
			findOverlay={{
				ref: findOverlayRef,
				isOpen: isFindOpen,
				query: findQuery,
				matchCount: findMatches,
				activeMatchOrdinal: findActiveOrdinal,
				matchCase: findMatchCase,
				onQueryChange: handleFindQueryChange,
				onMatchCaseChange: handleMatchCaseChange,
				onFindNext: handleFindNext,
				onFindPrevious: handleFindPrevious,
				onClose: closeFindOverlay,
			}}
			contentKeyDownCapture={(event) => {
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
			overflowMenu={
				<BrowserOverflowMenu
					paneId={paneId}
					currentUrl={displayedUrl}
					hasPage={displayedHasPage}
				/>
			}
			viewport={
				<>
					<div ref={containerRef} className="h-full w-full" style={{ flex: 1 }} />
					<div
						ref={secondaryContainerRef}
						className="absolute inset-0 pointer-events-none"
					/>
				</>
			}
		/>
	);
}
