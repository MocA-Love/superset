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
import {
	type ComponentPropsWithoutRef,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type BrowserBookmark,
	findBookmarkParentFolderId,
	getBookmarkFolderOptions,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { EditBookmarkDialog } from "./components/EditBookmarkDialog";

interface BookmarkBarItemProps {
	bookmark: BrowserBookmark;
	isActive: boolean;
	onNavigate: (url: string) => void;
	sortable?: boolean;
	compact?: boolean;
	dragAxis?: "horizontal" | "vertical";
}

interface BookmarkButtonProps {
	bookmark: BrowserBookmark;
	isActive: boolean;
	label: string;
	faviconFailed: boolean;
	onNavigate: (url: string) => void;
	onFaviconError: () => void;
	compact: boolean;
	sortable: boolean;
	attributes?: ComponentPropsWithoutRef<"button">;
	listeners?: ComponentPropsWithoutRef<"button">;
}

function BookmarkButton({
	bookmark,
	isActive,
	label,
	faviconFailed,
	onNavigate,
	onFaviconError,
	compact,
	sortable,
	attributes,
	listeners,
}: BookmarkButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					{...(attributes ?? {})}
					{...(listeners ?? {})}
					onClick={() => onNavigate(bookmark.url)}
					className={cn(
						"flex h-7 cursor-pointer items-center gap-2 rounded-md border px-2 text-xs transition-colors",
						compact ? "w-full max-w-full" : "max-w-52",
						"border-transparent bg-transparent text-muted-foreground/75 hover:bg-accent/70 hover:text-foreground",
						sortable && "active:cursor-grabbing",
						isActive && "border-border bg-accent text-foreground shadow-sm",
					)}
				>
					{bookmark.faviconUrl && !faviconFailed ? (
						<img
							src={bookmark.faviconUrl}
							alt=""
							className="size-3.5 shrink-0 rounded-sm"
							onError={onFaviconError}
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
	);
}

interface SortableBookmarkTriggerProps {
	bookmark: BrowserBookmark;
	isActive: boolean;
	label: string;
	faviconFailed: boolean;
	onNavigate: (url: string) => void;
	onFaviconError: () => void;
	compact: boolean;
	dragAxis: "horizontal" | "vertical";
}

function SortableBookmarkTrigger({
	bookmark,
	isActive,
	label,
	faviconFailed,
	onNavigate,
	onFaviconError,
	compact,
	dragAxis,
}: SortableBookmarkTriggerProps) {
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
			transform: CSS.Transform.toString(
				transform
					? dragAxis === "vertical"
						? { ...transform, x: 0 }
						: { ...transform, y: 0 }
					: null,
			),
			transition,
		}),
		[dragAxis, transform, transition],
	);

	return (
		<ContextMenuTrigger asChild>
			<div
				ref={setNodeRef}
				style={style}
				className={cn(
					"shrink-0",
					isDragging && "opacity-45",
					compact && "w-full",
				)}
			>
				<BookmarkButton
					bookmark={bookmark}
					isActive={isActive}
					label={label}
					faviconFailed={faviconFailed}
					onNavigate={onNavigate}
					onFaviconError={onFaviconError}
					compact={compact}
					sortable
					attributes={attributes}
					listeners={listeners}
				/>
			</div>
		</ContextMenuTrigger>
	);
}

export function BookmarkBarItem({
	bookmark,
	isActive,
	onNavigate,
	sortable = true,
	compact = false,
	dragAxis = "horizontal",
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
	const duplicateBookmark = useBrowserBookmarksStore(
		(state) => state.duplicateBookmark,
	);
	const removeNode = useBrowserBookmarksStore((state) => state.removeNode);
	const bookmarks = useBrowserBookmarksStore((state) => state.bookmarks);
	const folderOptions = useMemo(
		() => getBookmarkFolderOptions(bookmarks),
		[bookmarks],
	);
	const currentFolderId = useMemo(
		() => findBookmarkParentFolderId(bookmarks, bookmark.id),
		[bookmarks, bookmark.id],
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
				{sortable ? (
					<SortableBookmarkTrigger
						bookmark={bookmark}
						isActive={isActive}
						label={label}
						faviconFailed={faviconFailed}
						onNavigate={onNavigate}
						onFaviconError={() => setFaviconFailed(true)}
						compact={compact}
						dragAxis={dragAxis}
					/>
				) : (
					<ContextMenuTrigger asChild>
						<div className={cn("shrink-0", compact && "w-full")}>
							<BookmarkButton
								bookmark={bookmark}
								isActive={isActive}
								label={label}
								faviconFailed={faviconFailed}
								onNavigate={onNavigate}
								onFaviconError={() => setFaviconFailed(true)}
								compact={compact}
								sortable={false}
							/>
						</div>
					</ContextMenuTrigger>
				)}
				<ContextMenuContent
					className="w-48"
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
							const duplicatedBookmark = duplicateBookmark(bookmark.id);
							if (!duplicatedBookmark) {
								toast.error("Failed to duplicate bookmark");
								return;
							}
							toast.success("Bookmark duplicated");
						}}
					>
						Copy Bookmark
					</ContextMenuItem>
					<ContextMenuItem
						onSelect={() => {
							shouldOpenEditDialogRef.current = true;
						}}
					>
						Edit Bookmark
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => removeNode(bookmark.id)}>
						Remove Bookmark
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<EditBookmarkDialog
				bookmark={bookmark}
				open={isEditOpen}
				onOpenChange={setIsEditOpen}
				folderOptions={folderOptions}
				initialFolderId={currentFolderId}
				onSave={({ title, url, folderId }) => {
					const updatedBookmark = updateBookmark(bookmark.id, {
						title,
						url,
						folderId,
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
