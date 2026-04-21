import { cn } from "@superset/ui/utils";
import { useCallback, useSyncExternalStore } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import { browserRuntimeRegistry } from "../../browserRuntimeRegistry";

interface BrowserTabBarProps {
	paneId: string;
}

export function BrowserTabBar({ paneId }: BrowserTabBarProps) {
	const tabs = useSyncExternalStore(
		useCallback(
			(cb) => browserRuntimeRegistry.onTabsChange(paneId, cb),
			[paneId],
		),
		useCallback(() => browserRuntimeRegistry.listTabs(paneId), [paneId]),
	);

	const handleActivate = useCallback(
		(tabId: string) => {
			browserRuntimeRegistry.activateTab(paneId, tabId);
		},
		[paneId],
	);

	const handleClose = useCallback(
		(tabId: string, e: React.MouseEvent) => {
			e.stopPropagation();
			browserRuntimeRegistry.closeTab(paneId, tabId);
		},
		[paneId],
	);

	const handleNew = useCallback(() => {
		browserRuntimeRegistry.createTab(paneId, "about:blank");
	}, [paneId]);

	// Hide the bar when there is a single primary tab and the user has
	// not opened any additional tabs yet — keeps the BrowserPane looking
	// exactly like before for simple cases.
	if (tabs.length <= 1) return null;

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
						onClick={() => handleActivate(t.tabId)}
						className="flex flex-1 min-w-0 items-center gap-1.5 text-left"
					>
						{t.faviconUrl ? (
							<img src={t.faviconUrl} alt="" className="size-3 shrink-0" />
						) : (
							<div className="size-3 shrink-0 rounded-sm bg-muted-foreground/20" />
						)}
						<span className="truncate">{t.title || t.url || "New tab"}</span>
					</button>
					{tabs.length > 1 && (
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
