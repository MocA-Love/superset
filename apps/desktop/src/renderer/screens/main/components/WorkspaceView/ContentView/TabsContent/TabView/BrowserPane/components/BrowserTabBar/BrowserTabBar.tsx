import { cn } from "@superset/ui/utils";
import { useCallback, useSyncExternalStore } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import {
	type SecondaryTabState,
	secondaryTabRegistry,
} from "../../hooks/useSecondaryTabs";

interface BrowserTabBarProps {
	paneId: string;
	/** URL of the primary tab as surfaced by tabs-store / persistent webview. */
	primaryUrl: string;
	primaryTitle: string;
	primaryFaviconUrl: string | null;
	primaryIsLoading: boolean;
	/** Which tab should be active. "primary" or a secondary tabId. */
	activeTabId: string;
	/** Called when the user picks a tab. Pass "primary" for the primary. */
	onActivate: (tabId: string) => void;
}

interface DisplayTab {
	tabId: string;
	url: string;
	title: string;
	faviconUrl: string | null;
	isLoading: boolean;
	isActive: boolean;
	isPrimary: boolean;
}

export function BrowserTabBar({
	paneId,
	primaryUrl,
	primaryTitle,
	primaryFaviconUrl,
	primaryIsLoading,
	activeTabId,
	onActivate,
}: BrowserTabBarProps) {
	const secondary = useSyncExternalStore<SecondaryTabState[]>(
		useCallback(
			(cb) => secondaryTabRegistry.onTabsChange(paneId, cb),
			[paneId],
		),
		useCallback(() => secondaryTabRegistry.listTabs(paneId), [paneId]),
	);

	const handleClose = useCallback(
		(tabId: string, e: React.MouseEvent) => {
			e.stopPropagation();
			secondaryTabRegistry.closeTab(paneId, tabId);
			if (activeTabId === tabId) onActivate("primary");
		},
		[paneId, activeTabId, onActivate],
	);

	const handleNew = useCallback(() => {
		const tabId = secondaryTabRegistry.createTab(paneId, "about:blank");
		if (tabId) onActivate(tabId);
	}, [paneId, onActivate]);

	// Hide the bar entirely when there's no secondary tab. Manual "New
	// Tab" lives in the overflow menu so single-tab panes stay clean.
	if (secondary.length === 0) return null;

	const tabs: DisplayTab[] = [
		{
			tabId: "primary",
			url: primaryUrl,
			title: primaryTitle,
			faviconUrl: primaryFaviconUrl,
			isLoading: primaryIsLoading,
			isActive: activeTabId === "primary",
			isPrimary: true,
		},
		...secondary.map((s) => ({
			tabId: s.tabId,
			url: s.url,
			title: s.title,
			faviconUrl: s.faviconUrl,
			isLoading: s.isLoading,
			isActive: activeTabId === s.tabId,
			isPrimary: false,
		})),
	];

	return (
		<div className="flex h-7 items-center gap-0.5 border-b bg-muted/40 px-1 shrink-0 overflow-x-auto">
			{tabs.map((t) => (
				<div
					key={t.tabId}
					className={cn(
						"group flex items-center gap-1.5 h-5 max-w-[180px] rounded px-1.5 text-[11px] shrink-0",
						t.isActive
							? "bg-background text-foreground"
							: "text-muted-foreground hover:bg-muted/80",
					)}
					title={t.title || t.url}
				>
					<button
						type="button"
						onClick={() => onActivate(t.tabId)}
						className="flex flex-1 min-w-0 items-center gap-1.5 text-left"
					>
						{t.faviconUrl ? (
							<img src={t.faviconUrl} alt="" className="size-3 shrink-0" />
						) : (
							<div className="size-3 shrink-0 rounded-sm bg-muted-foreground/20" />
						)}
						<span className="truncate">
							{t.title || t.url || (t.isPrimary ? "Tab" : "New tab")}
						</span>
					</button>
					{!t.isPrimary && (
						<button
							type="button"
							onClick={(e) => handleClose(t.tabId, e)}
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
				onClick={handleNew}
				className="flex items-center justify-center size-5 rounded text-muted-foreground hover:bg-muted/80"
				title="New tab"
			>
				<LuPlus className="size-3" />
			</button>
		</div>
	);
}
