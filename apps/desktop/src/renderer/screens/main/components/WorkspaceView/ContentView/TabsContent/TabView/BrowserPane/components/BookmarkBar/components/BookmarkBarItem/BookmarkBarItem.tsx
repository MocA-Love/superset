import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type BrowserBookmark,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { EditBookmarkDialog } from "./components/EditBookmarkDialog";

interface BookmarkBarItemProps {
	bookmark: BrowserBookmark;
	isActive: boolean;
	onNavigate: (url: string) => void;
	onRemove: (bookmarkId: string) => void;
}

export function BookmarkBarItem({
	bookmark,
	isActive,
	onNavigate,
	onRemove,
}: BookmarkBarItemProps) {
	const [faviconFailed, setFaviconFailed] = useState(false);
	const [isEditOpen, setIsEditOpen] = useState(false);
	const shouldOpenEditDialogRef = useRef(false);
	const pendingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const updateBookmark = useBrowserBookmarksStore(
		(state) => state.updateBookmark,
	);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: bookmark.id,
	});

	const style = useMemo(
		() => ({
			transform: CSS.Transform.toString(transform),
			transition,
		}),
		[transform, transition],
	);

	const label = bookmark.title.trim() || bookmark.url;

	useEffect(() => {
		return () => {
			if (pendingOpenTimerRef.current !== null) {
				clearTimeout(pendingOpenTimerRef.current);
			}
		};
	}, []);

	const scheduleEditDialogOpen = () => {
		if (pendingOpenTimerRef.current !== null) {
			clearTimeout(pendingOpenTimerRef.current);
		}
		pendingOpenTimerRef.current = setTimeout(() => {
			pendingOpenTimerRef.current = null;
			setIsEditOpen(true);
		}, 0);
	};

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						ref={setNodeRef}
						style={style}
						className={cn("shrink-0", isDragging && "opacity-45")}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									{...attributes}
									{...listeners}
									onClick={() => onNavigate(bookmark.url)}
									className={cn(
										"flex h-7 max-w-52 cursor-pointer items-center gap-2 rounded-md border px-2 text-xs transition-colors",
										"border-transparent bg-transparent text-muted-foreground/75 hover:bg-accent/70 hover:text-foreground",
										"active:cursor-grabbing",
										isActive &&
											"border-border bg-accent text-foreground shadow-sm",
									)}
								>
									{bookmark.faviconUrl && !faviconFailed ? (
										<img
											src={bookmark.faviconUrl}
											alt=""
											className="size-3.5 shrink-0 rounded-sm"
											onError={() => setFaviconFailed(true)}
										/>
									) : (
										<GlobeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
									)}
									<span className="truncate">{label}</span>
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{bookmark.url}
							</TooltipContent>
						</Tooltip>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent
					className="w-44"
					onCloseAutoFocus={(event) => {
						if (!shouldOpenEditDialogRef.current) return;
						shouldOpenEditDialogRef.current = false;
						event.preventDefault();
						scheduleEditDialogOpen();
					}}
				>
					<ContextMenuItem onSelect={() => onNavigate(bookmark.url)}>
						Open Bookmark
					</ContextMenuItem>
					<ContextMenuItem
						onSelect={() => {
							shouldOpenEditDialogRef.current = true;
						}}
					>
						Edit Bookmark
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => onRemove(bookmark.id)}>
						Remove Bookmark
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<EditBookmarkDialog
				bookmark={bookmark}
				open={isEditOpen}
				onOpenChange={setIsEditOpen}
				onSave={({ title, url }) => {
					const updatedBookmark = updateBookmark(bookmark.id, {
						title,
						url,
						faviconUrl: bookmark.faviconUrl,
					});
					if (!updatedBookmark) {
						toast.error("Failed to update bookmark");
						return;
					}
					setIsEditOpen(false);
					toast.success("Bookmark updated");
				}}
			/>
		</>
	);
}
