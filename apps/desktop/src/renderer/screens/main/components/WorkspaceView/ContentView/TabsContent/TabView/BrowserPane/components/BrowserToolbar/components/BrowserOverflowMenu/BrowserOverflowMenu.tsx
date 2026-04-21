import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { useEffect, useRef, useState } from "react";
import {
	TbCamera,
	TbClock,
	TbCopy,
	TbDots,
	TbDownload,
	TbFolderPlus,
	TbPlus,
	TbReload,
	TbTrash,
	TbUpload,
} from "react-icons/tb";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useBrowserBookmarksStore } from "renderer/stores/browser-bookmarks";
import {
	exportBrowserBookmarksToHtml,
	importBrowserBookmarksFromHtml,
} from "renderer/stores/browser-bookmarks-html";
import { useTabsStore } from "renderer/stores/tabs/store";
import { secondaryTabRegistry } from "../../../../hooks/useSecondaryTabs";
import { BookmarkFolderDialog } from "../../../BookmarkFolderDialog";

interface BrowserOverflowMenuProps {
	paneId: string;
	hasPage: boolean;
}

export function BrowserOverflowMenu({
	paneId,
	hasPage,
}: BrowserOverflowMenuProps) {
	const screenshotMutation = electronTrpc.browser.screenshot.useMutation();
	const reloadMutation = electronTrpc.browser.reload.useMutation();
	const clearBrowsingDataMutation =
		electronTrpc.browser.clearBrowsingData.useMutation();
	const clearHistoryMutation = electronTrpc.browserHistory.clear.useMutation();
	const openTextFileMutation = electronTrpc.external.openTextFile.useMutation();
	const saveTextFileMutation = electronTrpc.external.saveTextFile.useMutation();
	const currentUrl = useTabsStore((s) => s.panes[paneId]?.browser?.currentUrl);
	const bookmarks = useBrowserBookmarksStore((state) => state.bookmarks);
	const addFolder = useBrowserBookmarksStore((state) => state.addFolder);
	const importBookmarks = useBrowserBookmarksStore(
		(state) => state.importBookmarks,
	);
	const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
	const shouldOpenNewFolderDialogRef = useRef(false);
	const pendingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	useEffect(() => {
		return () => {
			if (pendingOpenTimerRef.current !== null) {
				clearTimeout(pendingOpenTimerRef.current);
			}
		};
	}, []);

	const scheduleNewFolderDialogOpen = () => {
		if (pendingOpenTimerRef.current !== null) {
			clearTimeout(pendingOpenTimerRef.current);
		}
		pendingOpenTimerRef.current = setTimeout(() => {
			pendingOpenTimerRef.current = null;
			setIsNewFolderOpen(true);
		}, 0);
	};

	const handleScreenshot = () => {
		screenshotMutation.mutate({ paneId });
	};

	const handleHardReload = () => {
		reloadMutation.mutate({ paneId, hard: true });
	};

	const { copyToClipboard } = useCopyToClipboard();

	const handleCopyUrl = () => {
		if (currentUrl) {
			copyToClipboard(currentUrl);
		}
	};

	const handleImportBookmarks = async () => {
		try {
			const file = await openTextFileMutation.mutateAsync({
				title: "Import Bookmarks",
				buttonLabel: "Import",
				filters: [{ name: "Bookmarks HTML", extensions: ["html", "htm"] }],
			});

			if (!file) {
				return;
			}

			const importedNodes = importBrowserBookmarksFromHtml(file.content);
			const result = importBookmarks(importedNodes);

			if (result.bookmarksAdded === 0 && result.foldersAdded === 0) {
				toast.error("No bookmarks were imported");
				return;
			}

			toast.success(
				`Imported ${result.bookmarksAdded} bookmarks and ${result.foldersAdded} folders`,
			);
		} catch (error) {
			console.error("[browser-bookmarks/import]", error);
			toast.error("Failed to import bookmarks", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	const handleExportBookmarks = async () => {
		try {
			const content = exportBrowserBookmarksToHtml(bookmarks);
			const saved = await saveTextFileMutation.mutateAsync({
				title: "Export Bookmarks",
				defaultPath: "bookmarks.html",
				buttonLabel: "Export",
				filters: [{ name: "Bookmarks HTML", extensions: ["html"] }],
				content,
			});

			if (!saved) {
				return;
			}

			toast.success("Bookmarks exported");
		} catch (error) {
			console.error("[browser-bookmarks/export]", error);
			toast.error("Failed to export bookmarks", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	const handleClearCookies = () => {
		clearBrowsingDataMutation.mutate({ type: "cookies" });
	};

	const handleClearHistory = () => {
		clearHistoryMutation.mutate();
	};

	const handleClearAllData = () => {
		clearBrowsingDataMutation.mutate({ type: "all" });
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
					>
						<TbDots className="size-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-52"
					onCloseAutoFocus={(event) => {
						if (!shouldOpenNewFolderDialogRef.current) return;
						shouldOpenNewFolderDialogRef.current = false;
						event.preventDefault();
						scheduleNewFolderDialogOpen();
					}}
				>
					<DropdownMenuItem
						onClick={() =>
							secondaryTabRegistry.createTab(paneId, "about:blank")
						}
						className="gap-2"
					>
						<TbPlus className="size-4" />
						New Tab
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={handleScreenshot}
						disabled={!hasPage}
						className="gap-2"
					>
						<TbCamera className="size-4" />
						Take Screenshot
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={handleHardReload}
						disabled={!hasPage}
						className="gap-2"
					>
						<TbReload className="size-4" />
						Hard Reload
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={handleCopyUrl}
						disabled={!hasPage}
						className="gap-2"
					>
						<TbCopy className="size-4" />
						Copy URL
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => {
							shouldOpenNewFolderDialogRef.current = true;
						}}
						className="gap-2"
					>
						<TbFolderPlus className="size-4" />
						New Folder
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleImportBookmarks} className="gap-2">
						<TbUpload className="size-4" />
						Import Bookmarks
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleExportBookmarks} className="gap-2">
						<TbDownload className="size-4" />
						Export Bookmarks
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={handleClearHistory} className="gap-2">
						<TbClock className="size-4" />
						Clear Browsing History
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleClearCookies} className="gap-2">
						<TbTrash className="size-4" />
						Clear Cookies
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleClearAllData} className="gap-2">
						<TbTrash className="size-4" />
						Clear All Data
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<BookmarkFolderDialog
				open={isNewFolderOpen}
				onOpenChange={setIsNewFolderOpen}
				dialogTitle="New Bookmark Folder"
				submitLabel="Create"
				onSave={({ title, iconKey, color }) => {
					addFolder({ title, iconKey, color });
					setIsNewFolderOpen(false);
					toast.success("Folder created");
				}}
			/>
		</>
	);
}
