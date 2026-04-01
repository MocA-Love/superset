import {
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
import { useMemo } from "react";
import {
	normalizeBookmarkUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { BookmarkBarItem } from "./components/BookmarkBarItem";

interface BookmarkBarProps {
	currentUrl: string;
	onNavigate: (url: string) => void;
}

export function BookmarkBar({ currentUrl, onNavigate }: BookmarkBarProps) {
	const bookmarks = useBrowserBookmarksStore((state) => state.bookmarks);
	const moveBookmark = useBrowserBookmarksStore((state) => state.moveBookmark);
	const removeBookmark = useBrowserBookmarksStore(
		(state) => state.removeBookmark,
	);

	const normalizedCurrentUrl = useMemo(
		() => normalizeBookmarkUrl(currentUrl),
		[currentUrl],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 8 },
		}),
	);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over) return;
		moveBookmark(String(active.id), String(over.id));
	};

	return (
		<div className="flex h-9 shrink-0 items-center border-b border-border/70 bg-background/95 px-2">
			{bookmarks.length > 0 ? (
				<DndContext sensors={sensors} onDragEnd={handleDragEnd}>
					<SortableContext
						items={bookmarks.map((bookmark) => bookmark.id)}
						strategy={horizontalListSortingStrategy}
					>
						<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
							{bookmarks.map((bookmark) => (
								<BookmarkBarItem
									key={bookmark.id}
									bookmark={bookmark}
									isActive={
										normalizeBookmarkUrl(bookmark.url) === normalizedCurrentUrl
									}
									onNavigate={onNavigate}
									onRemove={removeBookmark}
								/>
							))}
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
