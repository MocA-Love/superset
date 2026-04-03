import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useEffect, useState } from "react";
import type { BrowserBookmark } from "renderer/stores/browser-bookmarks";

interface FolderOption {
	id: string;
	label: string;
}

interface EditBookmarkDialogProps {
	bookmark: BrowserBookmark;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	folderOptions: FolderOption[];
	initialFolderId: string | null;
	onSave: (values: {
		title: string;
		url: string;
		folderId: string | null;
	}) => void;
}

export function EditBookmarkDialog({
	bookmark,
	open,
	onOpenChange,
	folderOptions,
	initialFolderId,
	onSave,
}: EditBookmarkDialogProps) {
	const [title, setTitle] = useState(bookmark.title);
	const [url, setUrl] = useState(bookmark.url);
	const [folderId, setFolderId] = useState<string | null>(initialFolderId);

	useEffect(() => {
		if (!open) return;
		setTitle(bookmark.title);
		setUrl(bookmark.url);
		setFolderId(initialFolderId);
	}, [bookmark.title, bookmark.url, initialFolderId, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Edit Bookmark</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						onSave({ title, url, folderId });
					}}
				>
					<div className="space-y-2">
						<Label htmlFor={`bookmark-title-${bookmark.id}`}>Title</Label>
						<Input
							id={`bookmark-title-${bookmark.id}`}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Bookmark title"
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`bookmark-url-${bookmark.id}`}>URL</Label>
						<Input
							id={`bookmark-url-${bookmark.id}`}
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://example.com"
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`bookmark-folder-${bookmark.id}`}>Folder</Label>
						<select
							id={`bookmark-folder-${bookmark.id}`}
							value={folderId ?? ""}
							onChange={(event) =>
								setFolderId(event.target.value ? event.target.value : null)
							}
							className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-hidden transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
						>
							<option value="">Bookmarks Bar</option>
							{folderOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit">Save</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
