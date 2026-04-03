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
import {
	BROWSER_BOOKMARK_FOLDER_ICON_OPTIONS,
	type BrowserBookmarkFolderIconKey,
} from "renderer/stores/browser-bookmark-folder-icons";

const FOLDER_COLOR_PRESETS = [
	{ label: "Slate", value: "#64748b" },
	{ label: "Blue", value: "#2563eb" },
	{ label: "Cyan", value: "#0891b2" },
	{ label: "Green", value: "#16a34a" },
	{ label: "Amber", value: "#d97706" },
	{ label: "Rose", value: "#e11d48" },
	{ label: "Violet", value: "#7c3aed" },
	{ label: "Gray", value: "#6b7280" },
] as const;

interface BookmarkFolderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialTitle?: string;
	initialIconKey?: BrowserBookmarkFolderIconKey;
	initialColor?: string | null;
	dialogTitle: string;
	submitLabel: string;
	onSave: (values: {
		title: string;
		iconKey: BrowserBookmarkFolderIconKey;
		color: string | null;
	}) => void;
}

export function BookmarkFolderDialog({
	open,
	onOpenChange,
	initialTitle = "",
	initialIconKey = "folder",
	initialColor = null,
	dialogTitle,
	submitLabel,
	onSave,
}: BookmarkFolderDialogProps) {
	const [title, setTitle] = useState(initialTitle);
	const [iconKey, setIconKey] =
		useState<BrowserBookmarkFolderIconKey>(initialIconKey);
	const [color, setColor] = useState(initialColor ?? "#64748b");

	useEffect(() => {
		if (!open) return;
		setTitle(initialTitle);
		setIconKey(initialIconKey);
		setColor(initialColor ?? "#64748b");
	}, [initialColor, initialIconKey, initialTitle, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{dialogTitle}</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						onSave({ title, iconKey, color });
					}}
				>
					<div className="space-y-2">
						<Label htmlFor="bookmark-folder-title">Folder Name</Label>
						<Input
							id="bookmark-folder-title"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Folder name"
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label>Icon</Label>
						<div className="grid grid-cols-3 gap-2">
							{BROWSER_BOOKMARK_FOLDER_ICON_OPTIONS.map((option) => {
								const Icon = option.icon;
								const isSelected = option.key === iconKey;

								return (
									<button
										key={option.key}
										type="button"
										onClick={() => setIconKey(option.key)}
										className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
											isSelected
												? "border-ring bg-accent text-foreground"
												: "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										}`}
									>
										<Icon
											className="size-4 shrink-0"
											style={color ? { color } : undefined}
										/>
										<span className="truncate">{option.label}</span>
									</button>
								);
							})}
						</div>
					</div>
					<div className="space-y-2">
						<Label>Color</Label>
						<div className="grid grid-cols-4 gap-2">
							{FOLDER_COLOR_PRESETS.map((preset) => {
								const isSelected = preset.value === color;

								return (
									<button
										key={preset.value}
										type="button"
										onClick={() => setColor(preset.value)}
										className={`flex items-center gap-2 rounded-md border px-2 py-2 text-sm transition-colors ${
											isSelected
												? "border-ring bg-accent text-foreground"
												: "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										}`}
									>
										<span
											className="size-4 shrink-0 rounded-full border border-black/10"
											style={{ backgroundColor: preset.value }}
										/>
										<span className="truncate">{preset.label}</span>
									</button>
								);
							})}
						</div>
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2">
								<Label
									htmlFor="bookmark-folder-custom-color"
									className="text-xs text-muted-foreground"
								>
									Custom
								</Label>
								<input
									id="bookmark-folder-custom-color"
									type="color"
									value={color ?? "#64748b"}
									onChange={(event) => setColor(event.target.value)}
									className="h-9 w-14 cursor-pointer rounded border border-input bg-background p-1"
								/>
							</div>
							<Button
								type="button"
								variant="outline"
								onClick={() => setColor("#64748b")}
							>
								Reset
							</Button>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit">{submitLabel}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
