import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserAutomationStore } from "renderer/stores/browser-automation";
import {
	findBookmarkByUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { useBrowserFullscreenStore } from "renderer/stores/browser-fullscreen";
import type { SplitPaneOptions } from "renderer/stores/tabs/types";
import { BrowserPaneChrome } from "../components/BrowserPaneChrome";
import type { BrowserFindOverlayHandle } from "../BrowserPane/components/BrowserFindOverlay";
import { BrowserOverflowMenu } from "../BrowserPane/components/BrowserToolbar/components/BrowserOverflowMenu";

interface TabStateSnapshot {
	tabId: string;
	currentUrl: string;
	pageTitle: string;
	faviconUrl: string | null;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: { code: number; description: string; url: string } | null;
}

interface BrowserPaneV3Props {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	initialUrl: string;
	isHostVisible: boolean;
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

export function BrowserPaneV3({
	paneId,
	path,
	tabId,
	initialUrl,
	isHostVisible,
	splitPaneAuto,
	removePane,
	setFocusedPane,
	onPopOut,
}: BrowserPaneV3Props) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const latestHostVisible = useRef(isHostVisible);
	const registered = useRef(false);
	const findOverlayRef = useRef<BrowserFindOverlayHandle | null>(null);

	const registerMut = electronTrpc.browserView.register.useMutation();
	const unregisterMut = electronTrpc.browserView.unregister.useMutation();
	const setBoundsMut = electronTrpc.browserView.setBounds.useMutation();
	const setHostVisibilityMut =
		electronTrpc.browserView.setHostVisibility.useMutation();
	const navigateMut = electronTrpc.browserView.navigate.useMutation();
	const goBackMut = electronTrpc.browserView.goBack.useMutation();
	const goForwardMut = electronTrpc.browserView.goForward.useMutation();
	const reloadMut = electronTrpc.browserView.reload.useMutation();
	const screenshotMut = electronTrpc.browserView.screenshot.useMutation();
	const openDevToolsMut =
		electronTrpc.browserView.openDevTools.useMutation();
	const findInPageMut = electronTrpc.browserView.findInPage.useMutation();
	const stopFindInPageMut =
		electronTrpc.browserView.stopFindInPage.useMutation();
	const setZoomLevelMut =
		electronTrpc.browserView.setZoomLevel.useMutation();
	const setSuspendedMut = electronTrpc.browserView.setSuspended.useMutation();

	const [tabs, setTabs] = useState<TabStateSnapshot[]>([]);
	const [activeTabId, setActiveTabId] = useState<string>("primary");
	const [isEditingUrl, setIsEditingUrl] = useState(false);
	const [isFindOpen, setIsFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findMatchCase, setFindMatchCase] = useState(false);
	const [findMatches, setFindMatches] = useState(0);
	const [findActiveOrdinal, setFindActiveOrdinal] = useState(0);
	const [zoomLevel, setZoomLevel] = useState(0);

	const isFullscreen = useBrowserFullscreenStore(
		(s) => s.fullscreenPaneId === paneId,
	);
	const isConnectOpenForThisPane = useBrowserAutomationStore(
		(s) => s.connectModal.isOpen && s.connectModal.paneId === paneId,
	);
	const closeConnectModal = useBrowserAutomationStore(
		(s) => s.closeConnectModal,
	);

	useEffect(() => {
		latestHostVisible.current = isHostVisible;
	}, [isHostVisible]);

	const activeTab = useMemo(
		() => tabs.find((tab) => tab.tabId === activeTabId) ?? null,
		[tabs, activeTabId],
	);
	const currentUrl = activeTab?.currentUrl ?? "about:blank";
	const pageTitle = activeTab?.pageTitle ?? "";
	const currentFaviconUrl = activeTab?.faviconUrl;
	const isLoading = activeTab?.isLoading ?? false;
	const loadError = activeTab?.error ?? null;
	const canGoBack = activeTab?.canGoBack ?? false;
	const canGoForward = activeTab?.canGoForward ?? false;
	const isBlankPage = !currentUrl || currentUrl === "about:blank";

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

	const pushBounds = useCallback(() => {
		if (!registered.current) return;
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setBoundsMut.mutate({
			paneId,
			bounds: {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
			},
		});
	}, [paneId, setBoundsMut]);

	useEffect(() => {
		let cancelled = false;
		void registerMut
			.mutateAsync({ paneId, initialUrl })
			.then(() => {
				if (cancelled) return;
				registered.current = true;
				setHostVisibilityMut.mutate({
					paneId,
					visible: latestHostVisible.current,
				});
				pushBounds();
			})
			.catch(() => {
				registered.current = false;
			});
		return () => {
			cancelled = true;
			unregisterMut.mutate({ paneId });
			registered.current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId, initialUrl]);

	electronTrpc.browserView.onTabs.useSubscription(
		{ paneId },
		{
			onData: (data) => {
				setTabs(data.tabs);
				setActiveTabId(data.activeTabId);
			},
		},
	);

	electronTrpc.browserView.onFindRequested.useSubscription(
		{ paneId },
		{
			onData: (event) => {
				if (event.type === "open") {
					setIsFindOpen(true);
					findOverlayRef.current?.focusInput();
				} else if (event.type === "escape" && isFindOpen) {
					setIsFindOpen(false);
					setFindMatches(0);
					setFindActiveOrdinal(0);
					stopFindInPageMut.mutate({ paneId, action: "clearSelection" });
				}
			},
		},
	);

	electronTrpc.browserView.onFoundInPage.useSubscription(
		{ paneId },
		{
			onData: (result) => {
				setFindMatches(result.matches);
				setFindActiveOrdinal(result.activeMatchOrdinal);
			},
		},
	);

	electronTrpc.browserView.onZoomChanged.useSubscription(
		{ paneId },
		{
			onData: ({ zoomLevel: level }) => {
				setZoomLevel(level);
			},
		},
	);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		let cancelled = false;
		const push = () => {
			if (cancelled) return;
			pushBounds();
		};
		const ro = new ResizeObserver(push);
		ro.observe(el);
		window.addEventListener("resize", push);
		window.addEventListener("scroll", push, true);
		push();
		return () => {
			cancelled = true;
			ro.disconnect();
			window.removeEventListener("resize", push);
			window.removeEventListener("scroll", push, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pushBounds]);

	useEffect(() => {
		if (!registered.current) return;
		setHostVisibilityMut.mutate({ paneId, visible: isHostVisible });
		if (!isHostVisible) return;
		pushBounds();
		const frameId = window.requestAnimationFrame(() => {
			pushBounds();
		});
		return () => window.cancelAnimationFrame(frameId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isHostVisible, paneId, pushBounds]);

	useEffect(() => {
		setSuspendedMut.mutate({
			paneId,
			suspended: isEditingUrl || isFindOpen || isConnectOpenForThisPane,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isEditingUrl, isFindOpen, isConnectOpenForThisPane, paneId]);

	const runFindQuery = useCallback(
		(
			text: string,
			opts?: { findNext?: boolean; forward?: boolean; matchCase?: boolean },
		) => {
			if (!text) {
				setFindMatches(0);
				setFindActiveOrdinal(0);
				stopFindInPageMut.mutate({ paneId, action: "clearSelection" });
				return;
			}
			findInPageMut.mutate({
				paneId,
				text,
				forward: opts?.forward ?? true,
				findNext: opts?.findNext ?? false,
				matchCase: opts?.matchCase ?? findMatchCase,
			});
		},
		[findInPageMut, findMatchCase, paneId, stopFindInPageMut],
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

	const closeFindOverlay = useCallback(() => {
		setIsFindOpen(false);
		setFindMatches(0);
		setFindActiveOrdinal(0);
		stopFindInPageMut.mutate({ paneId, action: "clearSelection" });
	}, [paneId, stopFindInPageMut]);

	const applyZoom = useCallback(
		(level: number) => {
			const clamped = Math.max(-3, Math.min(5, level));
			setZoomLevel(clamped);
			setZoomLevelMut.mutate({ paneId, level: clamped });
		},
		[paneId, setZoomLevelMut],
	);

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
			currentUrl={currentUrl}
			pageTitle={pageTitle}
			isLoading={isLoading}
			isBlankPage={isBlankPage}
			loadError={loadError}
			isBookmarked={Boolean(currentBookmark)}
			canGoBack={canGoBack}
			canGoForward={canGoForward}
			onGoBack={() => goBackMut.mutate({ paneId })}
			onGoForward={() => goForwardMut.mutate({ paneId })}
			onReload={() => reloadMut.mutate({ paneId, hard: false })}
			onNavigate={(url) => navigateMut.mutate({ paneId, url })}
			onToggleBookmark={handleToggleBookmark}
			onEditingChange={setIsEditingUrl}
			onOpenDevTools={() => openDevToolsMut.mutate({ paneId })}
			zoomLevel={zoomLevel}
			onZoomChange={applyZoom}
			bookmarkBar={{
				currentUrl,
				onNavigate: (url) => navigateMut.mutate({ paneId, url }),
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
					setIsFindOpen(true);
					findOverlayRef.current?.focusInput();
				} else if (event.key === "Escape" && isFindOpen) {
					event.preventDefault();
					closeFindOverlay();
				}
			}}
			overflowMenu={
				<BrowserOverflowMenu
					paneId={paneId}
					currentUrl={currentUrl}
					hasPage={!isBlankPage}
					onTakeScreenshot={() => screenshotMut.mutate({ paneId })}
					onHardReload={() => reloadMut.mutate({ paneId, hard: true })}
				/>
			}
			viewport={
				<div
					ref={containerRef}
					className="flex-1 w-full min-h-0"
					style={{ flex: 1 }}
				/>
			}
		/>
	);
}
