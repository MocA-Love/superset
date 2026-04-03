import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	MouseSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { GripVerticalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBrowserBookmarkFolderIcon } from "renderer/stores/browser-bookmark-folder-icons";
import {
	type BrowserBookmarkFolder,
	type BrowserBookmarkTreeNode,
	isBrowserBookmark,
	normalizeBookmarkUrl,
	useBrowserBookmarksStore,
} from "renderer/stores/browser-bookmarks";
import { setPersistentWebviewInteractionLock } from "../../../../hooks/usePersistentWebview";
import { BookmarkFolderDialog } from "../../../BookmarkFolderDialog";
import { BookmarkBarItem } from "../BookmarkBarItem";

interface BookmarkFolderItemProps {
	folder: BrowserBookmarkFolder;
	currentUrl: string;
	onNavigate: (url: string) => void;
}

interface FolderTreeSectionProps {
	folderId: string;
	nodes: BrowserBookmarkTreeNode[];
	onNavigate: (url: string) => void;
	currentUrl: string;
	onReorder: (folderId: string, activeId: string, overId: string) => void;
}

interface SortableFolderMenuNodeProps {
	folder: BrowserBookmarkFolder;
	onNavigate: (url: string) => void;
	currentUrl: string;
	onReorder: (folderId: string, activeId: string, overId: string) => void;
}

function SortableFolderMenuNode({
	folder,
	onNavigate,
	currentUrl,
	onReorder,
}: SortableFolderMenuNodeProps) {
	const FolderIcon = getBrowserBookmarkFolderIcon(folder.iconKey);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: folder.id,
	});

	const style = useMemo(
		() => ({
			transform: CSS.Transform.toString(
				transform ? { ...transform, x: 0 } : null,
			),
			transition,
		}),
		[transform, transition],
	);

	return (
		<div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-45")}>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger className="gap-2 pr-1.5">
					<FolderIcon
						className="size-3.5 shrink-0"
						style={folder.color ? { color: folder.color } : undefined}
					/>
					<span className="min-w-0 flex-1 truncate">{folder.title}</span>
					<button
						type="button"
						{...attributes}
						{...listeners}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						className="flex shrink-0 items-center text-muted-foreground/55 transition-colors hover:text-foreground active:cursor-grabbing"
						aria-label={`Reorder ${folder.title}`}
					>
						<GripVerticalIcon className="size-3.5 shrink-0" />
					</button>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent
					sideOffset={8}
					className="max-h-[28rem] w-80 overflow-y-auto p-1.5"
				>
					{folder.children.length > 0 ? (
						<FolderTreeSection
							folderId={folder.id}
							nodes={folder.children}
							onNavigate={onNavigate}
							currentUrl={currentUrl}
							onReorder={onReorder}
						/>
					) : (
						<div className="px-2 py-1 text-xs text-muted-foreground/60">
							Folder is empty.
						</div>
					)}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</div>
	);
}

function FolderTreeSection({
	folderId,
	nodes,
	onNavigate,
	currentUrl,
	onReorder,
}: FolderTreeSectionProps) {
	const dragLockId = `bookmark-folder-dnd-${folderId}`;
	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 8 },
		}),
	);
	const itemIds = useMemo(() => nodes.map((node) => node.id), [nodes]);

	useEffect(() => {
		return () => {
			setPersistentWebviewInteractionLock(dragLockId, false);
		};
	}, [dragLockId]);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		setPersistentWebviewInteractionLock(dragLockId, false);
		if (!over) return;
		onReorder(folderId, String(active.id), String(over.id));
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={() => {
				setPersistentWebviewInteractionLock(dragLockId, true);
			}}
			onDragCancel={() => {
				setPersistentWebviewInteractionLock(dragLockId, false);
			}}
			onDragEnd={handleDragEnd}
		>
			<SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
				<div className="space-y-1">
					{nodes.map((node) => {
						if (isBrowserBookmark(node)) {
							return (
								<BookmarkBarItem
									key={node.id}
									bookmark={node}
									isActive={
										normalizeBookmarkUrl(node.url) ===
										normalizeBookmarkUrl(currentUrl)
									}
									onNavigate={onNavigate}
									sortable
									compact
									dragAxis="vertical"
								/>
							);
						}

						return (
							<SortableFolderMenuNode
								key={node.id}
								folder={node}
								onNavigate={onNavigate}
								currentUrl={currentUrl}
								onReorder={onReorder}
							/>
						);
					})}
				</div>
			</SortableContext>
		</DndContext>
	);
}

export function BookmarkFolderItem({
	folder,
	currentUrl,
	onNavigate,
}: BookmarkFolderItemProps) {
	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const shouldOpenEditDialogRef = useRef(false);
	const pendingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const menuLockId = `bookmark-folder-menu-${folder.id}`;
	const updateFolder = useBrowserBookmarksStore((state) => state.updateFolder);
	const reorderFolderChildren = useBrowserBookmarksStore(
		(state) => state.reorderFolderChildren,
	);
	const removeNode = useBrowserBookmarksStore((state) => state.removeNode);
	const FolderIcon = getBrowserBookmarkFolderIcon(folder.iconKey);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: folder.id,
	});

	const style = useMemo(
		() => ({
			transform: CSS.Transform.toString(
				transform ? { ...transform, y: 0 } : null,
			),
			transition,
		}),
		[transform, transition],
	);

	useEffect(() => {
		return () => {
			if (pendingOpenTimerRef.current !== null) {
				clearTimeout(pendingOpenTimerRef.current);
			}
			setPersistentWebviewInteractionLock(menuLockId, false);
		};
	}, [menuLockId]);

	useEffect(() => {
		setPersistentWebviewInteractionLock(menuLockId, isMenuOpen);
		return () => {
			setPersistentWebviewInteractionLock(menuLockId, false);
		};
	}, [isMenuOpen, menuLockId]);

	const scheduleEditDialogOpen = () => {
		if (pendingOpenTimerRef.current !== null) {
			clearTimeout(pendingOpenTimerRef.current);
		}
		pendingOpenTimerRef.current = setTimeout(() => {
			pendingOpenTimerRef.current = null;
			setIsEditOpen(true);
		}, 0);
	};

	const handleNavigateFromFolder = (url: string) => {
		setIsMenuOpen(false);
		onNavigate(url);
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
						<DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
							<div
								className={cn(
									"flex h-7 min-w-0 max-w-56 items-center rounded-md border transition-colors",
									"border-transparent bg-transparent text-muted-foreground/75 hover:bg-accent/70 hover:text-foreground",
								)}
							>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs"
									>
										<FolderIcon
											className="size-3.5 shrink-0"
											style={folder.color ? { color: folder.color } : undefined}
										/>
										<span className="truncate">{folder.title}</span>
									</button>
								</DropdownMenuTrigger>
								<button
									type="button"
									{...attributes}
									{...listeners}
									className="flex h-full shrink-0 items-center px-1.5 text-muted-foreground/55 transition-colors hover:text-foreground active:cursor-grabbing"
									aria-label={`Reorder ${folder.title}`}
								>
									<GripVerticalIcon className="size-3.5 shrink-0" />
								</button>
							</div>
							<DropdownMenuContent
								align="start"
								className="max-h-[28rem] w-80 overflow-y-auto p-1.5"
							>
								{folder.children.length > 0 ? (
									<FolderTreeSection
										folderId={folder.id}
										nodes={folder.children}
										onNavigate={handleNavigateFromFolder}
										currentUrl={currentUrl}
										onReorder={reorderFolderChildren}
									/>
								) : (
									<div className="px-2 py-1 text-xs text-muted-foreground/60">
										Folder is empty.
									</div>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
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
					<ContextMenuItem
						onSelect={() => {
							shouldOpenEditDialogRef.current = true;
						}}
					>
						Edit Folder
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => removeNode(folder.id)}>
						Remove Folder
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<BookmarkFolderDialog
				open={isEditOpen}
				onOpenChange={setIsEditOpen}
				initialTitle={folder.title}
				initialIconKey={folder.iconKey}
				initialColor={folder.color}
				dialogTitle="Edit Folder"
				submitLabel="Save"
				onSave={({ title, iconKey, color }) => {
					const updatedFolder = updateFolder(folder.id, {
						title,
						iconKey,
						color,
					});
					if (!updatedFolder) {
						toast.error("Failed to update folder");
						return;
					}
					setIsEditOpen(false);
					toast.success("Folder updated");
				}}
			/>
		</>
	);
}
