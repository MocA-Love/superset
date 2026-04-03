import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	MouseSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	horizontalListSortingStrategy,
	SortableContext,
} from "@dnd-kit/sortable";
import { cn } from "@superset/ui/utils";
import { useEffect, useMemo } from "react";
import {
	folderContainsBookmarkUrl,
	isBrowserBookmark,
	normalizeBookmarkUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { setPersistentWebviewInteractionLock } from "../../hooks/usePersistentWebview";
import { BookmarkBarItem } from "./components/BookmarkBarItem";
import { BookmarkFolderItem } from "./components/BookmarkFolderItem";

interface BookmarkBarProps {
	currentUrl: string;
	onNavigate: (url: string) => void;
}

export function BookmarkBar({ currentUrl, onNavigate }: BookmarkBarProps) {
	const bookmarks = useBrowserBookmarksStore((state) => state.bookmarks);
	const moveNode = useBrowserBookmarksStore((state) => state.moveNode);
	const normalizedCurrentUrl = useMemo(
		() => normalizeBookmarkUrl(currentUrl),
		[currentUrl],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 8 },
		}),
	);

	useEffect(() => {
		return () => {
			setPersistentWebviewInteractionLock("bookmark-bar-dnd", false);
		};
	}, []);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		setPersistentWebviewInteractionLock("bookmark-bar-dnd", false);
		if (!over) return;
		moveNode(String(active.id), String(over.id));
	};

	const rootIds = useMemo(
		() => bookmarks.map((bookmark) => bookmark.id),
		[bookmarks],
	);

	return (
		<div className="flex h-9 shrink-0 items-center border-b border-border/70 bg-background/95 px-2">
			{bookmarks.length > 0 ? (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragStart={() => {
						setPersistentWebviewInteractionLock("bookmark-bar-dnd", true);
					}}
					onDragCancel={() => {
						setPersistentWebviewInteractionLock("bookmark-bar-dnd", false);
					}}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={rootIds}
						strategy={horizontalListSortingStrategy}
					>
						<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-y-none pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
							{bookmarks.map((bookmark) =>
								isBrowserBookmark(bookmark) ? (
									<BookmarkBarItem
										key={bookmark.id}
										bookmark={bookmark}
										isActive={
											normalizeBookmarkUrl(bookmark.url) ===
											normalizedCurrentUrl
										}
										onNavigate={onNavigate}
									/>
								) : (
									<BookmarkFolderItem
										key={bookmark.id}
										folder={bookmark}
										currentUrl={currentUrl}
										isActive={folderContainsBookmarkUrl(
											bookmark,
											normalizedCurrentUrl,
										)}
										onNavigate={onNavigate}
									/>
								),
							)}
						</div>
					</SortableContext>
				</DndContext>
			) : (
				<div
					className={cn(
						"min-w-0 truncate px-2 text-[11px] text-muted-foreground/55",
					)}
				>
					Click the star in the address bar to add bookmarks.
				</div>
			)}
		</div>
	);
}
