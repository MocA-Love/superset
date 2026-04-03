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
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
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
	isActive: boolean;
	currentUrl: string;
	onNavigate: (url: string) => void;
}

interface FolderTreeSectionProps {
	folderId: string;
	nodes: BrowserBookmarkTreeNode[];
	onNavigate: (url: string) => void;
	currentUrl: string;
	onReorder: (folderId: string, activeId: string, overId: string) => void;
	depth?: number;
}

function FolderTreeSection({
	folderId,
	nodes,
	onNavigate,
	currentUrl,
	onReorder,
	depth = 0,
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

						const NestedFolderIcon = getBrowserBookmarkFolderIcon(node.iconKey);

						return (
							<div key={node.id} className="space-y-1">
								<div
									className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-muted-foreground/75"
									style={{ marginLeft: depth * 10 }}
								>
									<NestedFolderIcon
										className="size-3.5 shrink-0"
										style={node.color ? { color: node.color } : undefined}
									/>
									<span className="truncate">{node.title}</span>
								</div>
								{node.children.length > 0 ? (
									<FolderTreeSection
										folderId={node.id}
										nodes={node.children}
										onNavigate={onNavigate}
										currentUrl={currentUrl}
										onReorder={onReorder}
										depth={depth + 1}
									/>
								) : null}
							</div>
						);
					})}
				</div>
			</SortableContext>
		</DndContext>
	);
}

export function BookmarkFolderItem({
	folder,
	isActive,
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
									isActive &&
										"border-border bg-accent text-foreground shadow-sm",
								)}
							>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<button
												type="button"
												className="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs"
											>
												<FolderIcon
													className="size-3.5 shrink-0"
													style={
														folder.color ? { color: folder.color } : undefined
													}
												/>
												<span className="truncate">{folder.title}</span>
											</button>
										</DropdownMenuTrigger>
									</TooltipTrigger>
									<TooltipContent side="bottom" showArrow={false}>
										{folder.title}
									</TooltipContent>
								</Tooltip>
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
										onNavigate={onNavigate}
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
