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

interface EditBookmarkDialogProps {
	bookmark: BrowserBookmark;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSave: (values: { title: string; url: string }) => void;
}

export function EditBookmarkDialog({
	bookmark,
	open,
	onOpenChange,
	onSave,
}: EditBookmarkDialogProps) {
	const [title, setTitle] = useState(bookmark.title);
	const [url, setUrl] = useState(bookmark.url);

	useEffect(() => {
		if (!open) return;
		setTitle(bookmark.title);
		setUrl(bookmark.url);
	}, [bookmark.title, bookmark.url, open]);

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
						onSave({ title, url });
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
