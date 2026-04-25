import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { GlobeIcon } from "lucide-react";
import {
	useCallback,
	useState,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
} from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { TbDeviceDesktop } from "react-icons/tb";
import type { MosaicBranch } from "react-mosaic-component";
import { ConnectButton } from "../../BrowserPane/components/ConnectButton";
import {
	BrowserFindOverlay,
	type BrowserFindOverlayHandle,
} from "../../BrowserPane/components/BrowserFindOverlay";
import { BookmarkBar } from "../../BrowserPane/components/BookmarkBar";
import { BrowserErrorOverlay } from "../../BrowserPane/components/BrowserErrorOverlay";
import { ExtensionToolbar } from "../../BrowserPane/components/ExtensionToolbar";
import { SessionConnectModal } from "../../BrowserPane/components/SessionConnectModal";
import { BrowserToolbar } from "../../BrowserPane/components/BrowserToolbar";
import { BasePaneWindow } from "../BasePaneWindow";
import { PaneToolbarActions } from "../PaneToolbarActions";

interface BrowserPaneChromeProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
		options?: unknown,
	) => void;
	splitPaneHorizontal?: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	splitPaneVertical?: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
	isFullscreen: boolean;
	isConnectOpen: boolean;
	onConnectOpenChange: (open: boolean) => void;
	currentUrl: string;
	pageTitle: string;
	isLoading: boolean;
	isBlankPage: boolean;
	loadError: {
		code: number;
		description: string;
		url: string;
	} | null;
	isBookmarked: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	onGoBack: () => void;
	onGoForward: () => void;
	onReload: () => void;
	onNavigate: (url: string) => void;
	onToggleBookmark: () => void;
	onEditingChange?: (editing: boolean) => void;
	onOpenDevTools?: () => void;
	zoomLevel?: number;
	onZoomChange?: (level: number) => void;
	zoomStep?: number;
	zoomMin?: number;
	zoomMax?: number;
	bookmarkBar?: {
		currentUrl: string;
		onNavigate: (url: string) => void;
	};
	findOverlay?: {
		ref: RefObject<BrowserFindOverlayHandle | null>;
		isOpen: boolean;
		query: string;
		matchCount: number;
		activeMatchOrdinal: number;
		matchCase: boolean;
		onQueryChange: (query: string) => void;
		onMatchCaseChange: (next: boolean) => void;
		onFindNext: () => void;
		onFindPrevious: () => void;
		onClose: () => void;
	};
	contentKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
	beforeViewport?: ReactNode;
	overflowMenu?: ReactNode;
	viewport: ReactNode;
}

export function BrowserPaneChrome({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	splitPaneHorizontal,
	splitPaneVertical,
	removePane,
	setFocusedPane,
	onPopOut,
	isFullscreen,
	isConnectOpen,
	onConnectOpenChange,
	currentUrl,
	pageTitle,
	isLoading,
	isBlankPage,
	loadError,
	isBookmarked,
	canGoBack,
	canGoForward,
	onGoBack,
	onGoForward,
	onReload,
	onNavigate,
	onToggleBookmark,
	onEditingChange,
	onOpenDevTools,
	zoomLevel,
	onZoomChange,
	zoomStep = 1,
	zoomMin = -3,
	zoomMax = 5,
	bookmarkBar,
	findOverlay,
	contentKeyDownCapture,
	beforeViewport,
	overflowMenu,
	viewport,
}: BrowserPaneChromeProps) {
	const [isEditingUrl, setIsEditingUrl] = useState(false);

	const handleEditingChange = useCallback(
		(editing: boolean) => {
			setIsEditingUrl(editing);
			onEditingChange?.(editing);
		},
		[onEditingChange],
	);

	const zoomPercent =
		typeof zoomLevel === "number" ? Math.round(1.2 ** zoomLevel * 100) : null;

	return (
		<>
			<BasePaneWindow
				paneId={paneId}
				path={path}
				tabId={tabId}
				splitPaneAuto={splitPaneAuto}
				splitPaneHorizontal={splitPaneHorizontal}
				splitPaneVertical={splitPaneVertical}
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
							isBookmarked={isBookmarked}
							canGoBack={canGoBack}
							canGoForward={canGoForward}
							onGoBack={onGoBack}
							onGoForward={onGoForward}
							onReload={onReload}
							onNavigate={onNavigate}
							onToggleBookmark={onToggleBookmark}
							onEditingChange={handleEditingChange}
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
										{typeof zoomLevel === "number" && onZoomChange ? (
											<div className="flex items-center gap-0.5">
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() =>
																onZoomChange(zoomLevel - zoomStep)
															}
															disabled={zoomLevel <= zoomMin}
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
															onClick={() => onZoomChange(0)}
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
															onClick={() =>
																onZoomChange(zoomLevel + zoomStep)
															}
															disabled={zoomLevel >= zoomMax}
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
										) : null}
										<ExtensionToolbar />
										{onOpenDevTools ? (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={onOpenDevTools}
														className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
													>
														<TbDeviceDesktop className="size-3.5" />
													</button>
												</TooltipTrigger>
												<TooltipContent side="bottom" showArrow={false}>
													Open DevTools
												</TooltipContent>
											</Tooltip>
										) : null}
										{overflowMenu}
									</>
								}
							/>
						</div>
					</div>
				)}
			>
				<div
					className="flex h-full flex-1 flex-col"
					onKeyDownCapture={contentKeyDownCapture}
				>
					{!isFullscreen && bookmarkBar ? (
						<BookmarkBar
							currentUrl={bookmarkBar.currentUrl}
							onNavigate={bookmarkBar.onNavigate}
						/>
					) : null}
					{beforeViewport}
					<div className="relative flex flex-1 min-h-0">
						{viewport}
						{findOverlay ? (
							<BrowserFindOverlay
								ref={findOverlay.ref}
								isOpen={findOverlay.isOpen}
								query={findOverlay.query}
								matchCount={findOverlay.matchCount}
								activeMatchOrdinal={findOverlay.activeMatchOrdinal}
								matchCase={findOverlay.matchCase}
								onQueryChange={findOverlay.onQueryChange}
								onMatchCaseChange={findOverlay.onMatchCaseChange}
								onFindNext={findOverlay.onFindNext}
								onFindPrevious={findOverlay.onFindPrevious}
								onClose={findOverlay.onClose}
							/>
						) : null}
						{loadError && !isLoading ? (
							<BrowserErrorOverlay error={loadError} onRetry={onReload} />
						) : null}
						{isBlankPage && !isLoading && !loadError ? (
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
						) : null}
					</div>
				</div>
			</BasePaneWindow>
			<SessionConnectModal
				open={isConnectOpen}
				onOpenChange={onConnectOpenChange}
			/>
		</>
	);
}
