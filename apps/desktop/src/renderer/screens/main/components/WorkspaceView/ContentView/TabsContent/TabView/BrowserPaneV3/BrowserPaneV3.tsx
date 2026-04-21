import { cn } from "@superset/ui/utils";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { LuPlus, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * WebContentsView-backed browser pane (v3).
 *
 * Replaces the legacy <webview>-based implementation. The placeholder
 * div here is pure DOM; the actual web content is rendered by a
 * native WebContentsView in the main process, positioned over this
 * placeholder's client rect. All tab-strip / toolbar chrome stays in
 * normal DOM above the placeholder — never stacked on top of the
 * view, which is what kept the <webview> design unstable.
 */

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
	initialUrl: string;
}

export function BrowserPaneV3({ paneId, initialUrl }: BrowserPaneV3Props) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const registered = useRef(false);

	const registerMut = electronTrpc.browserView.register.useMutation();
	const unregisterMut = electronTrpc.browserView.unregister.useMutation();
	const setBoundsMut = electronTrpc.browserView.setBounds.useMutation();
	const createTabMut = electronTrpc.browserView.createTab.useMutation();
	const closeTabMut = electronTrpc.browserView.closeTab.useMutation();
	const activateTabMut = electronTrpc.browserView.activateTab.useMutation();
	const navigateMut = electronTrpc.browserView.navigate.useMutation();
	const goBackMut = electronTrpc.browserView.goBack.useMutation();
	const goForwardMut = electronTrpc.browserView.goForward.useMutation();
	const reloadMut = electronTrpc.browserView.reload.useMutation();
	const setSuspendedMut = electronTrpc.browserView.setSuspended.useMutation();

	const [tabs, setTabs] = useState<TabStateSnapshot[]>([]);
	const [activeTabId, setActiveTabId] = useState<string>("primary");

	// Register + unregister on mount/unmount.
	useEffect(() => {
		registerMut.mutate({ paneId, initialUrl });
		registered.current = true;
		return () => {
			unregisterMut.mutate({ paneId });
			registered.current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId, initialUrl, registerMut.mutate, unregisterMut.mutate]);

	// Subscribe to tab list + active tab from main.
	electronTrpc.browserView.onTabs.useSubscription(
		{ paneId },
		{
			onData: (data) => {
				setTabs(data.tabs);
				setActiveTabId(data.activeTabId);
			},
		},
	);

	// Sync bounds whenever the placeholder resizes or scrolls.
	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		let cancelled = false;
		const push = () => {
			if (cancelled) return;
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
	}, [paneId, setBoundsMut.mutate]);

	const activeTab = useMemo(
		() => tabs.find((t) => t.tabId === activeTabId) ?? null,
		[tabs, activeTabId],
	);

	// URL editing: suspend the WebContentsView while the user is
	// interacting with the URL bar / suggestion popover so clicks go
	// to DOM chrome, not the native view below.
	const [isEditingUrl, setIsEditingUrl] = useState(false);
	useEffect(() => {
		setSuspendedMut.mutate({ paneId, suspended: isEditingUrl });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isEditingUrl, paneId, setSuspendedMut.mutate]);

	const [urlDraft, setUrlDraft] = useState("");
	useEffect(() => {
		if (!isEditingUrl) setUrlDraft(activeTab?.currentUrl ?? "");
	}, [activeTab?.currentUrl, isEditingUrl]);

	const handleSubmitUrl = useCallback(
		(e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!urlDraft.trim()) return;
			navigateMut.mutate({ paneId, url: urlDraft.trim() });
			setIsEditingUrl(false);
		},
		[navigateMut, paneId, urlDraft],
	);

	return (
		<div className="relative flex h-full w-full flex-col">
			{/* Tab bar */}
			<div className="flex h-7 items-center gap-0.5 border-b bg-muted/40 px-1 shrink-0 overflow-x-auto">
				{tabs.map((t) => (
					<div
						key={t.tabId}
						className={cn(
							"group flex items-center gap-1.5 h-5 max-w-[180px] rounded px-1.5 text-[11px] shrink-0",
							t.tabId === activeTabId
								? "bg-background text-foreground"
								: "text-muted-foreground hover:bg-muted/80",
						)}
						title={t.pageTitle || t.currentUrl}
					>
						<button
							type="button"
							onClick={() => activateTabMut.mutate({ paneId, tabId: t.tabId })}
							className="flex flex-1 min-w-0 items-center gap-1.5 text-left"
						>
							{t.faviconUrl ? (
								<img src={t.faviconUrl} alt="" className="size-3 shrink-0" />
							) : (
								<div className="size-3 shrink-0 rounded-sm bg-muted-foreground/20" />
							)}
							<span className="truncate">
								{t.pageTitle || t.currentUrl || "New tab"}
							</span>
						</button>
						{tabs.length > 1 && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									closeTabMut.mutate({ paneId, tabId: t.tabId });
								}}
								className="ml-0.5 opacity-60 hover:opacity-100"
								aria-label="Close tab"
							>
								<LuX className="size-3" />
							</button>
						)}
					</div>
				))}
				<button
					type="button"
					onClick={() =>
						createTabMut.mutate({ paneId, url: "about:blank", activate: true })
					}
					className="flex items-center justify-center size-5 rounded text-muted-foreground hover:bg-muted/80"
					title="New tab"
				>
					<LuPlus className="size-3" />
				</button>
			</div>

			{/* Toolbar */}
			<div className="flex items-center gap-1 px-2 py-1 border-b shrink-0 bg-background">
				<button
					type="button"
					onClick={() => goBackMut.mutate({ paneId })}
					disabled={!activeTab?.canGoBack}
					className="px-2 py-0.5 text-xs rounded hover:bg-muted disabled:opacity-30"
				>
					←
				</button>
				<button
					type="button"
					onClick={() => goForwardMut.mutate({ paneId })}
					disabled={!activeTab?.canGoForward}
					className="px-2 py-0.5 text-xs rounded hover:bg-muted disabled:opacity-30"
				>
					→
				</button>
				<button
					type="button"
					onClick={() => reloadMut.mutate({ paneId, hard: false })}
					className="px-2 py-0.5 text-xs rounded hover:bg-muted"
				>
					↻
				</button>
				<form onSubmit={handleSubmitUrl} className="flex-1">
					<input
						type="text"
						value={isEditingUrl ? urlDraft : (activeTab?.currentUrl ?? "")}
						onChange={(e) => {
							setUrlDraft(e.target.value);
							if (!isEditingUrl) setIsEditingUrl(true);
						}}
						onFocus={() => {
							setUrlDraft(activeTab?.currentUrl ?? "");
							setIsEditingUrl(true);
						}}
						onBlur={() => setIsEditingUrl(false)}
						placeholder="Enter URL or search..."
						className="w-full h-6 rounded bg-muted/40 px-2 text-xs outline-none focus:bg-background focus:ring-1 focus:ring-brand"
					/>
				</form>
			</div>

			{/* Placeholder — main process positions the WebContentsView over this rect */}
			<div
				ref={containerRef}
				className="flex-1 w-full min-h-0"
				style={{ flex: 1 }}
			/>
		</div>
	);
}
