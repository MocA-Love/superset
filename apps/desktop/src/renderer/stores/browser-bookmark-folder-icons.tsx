import type { LucideIcon } from "lucide-react";
import {
	BookIcon,
	BriefcaseIcon,
	CodeIcon,
	FileIcon,
	FolderIcon,
	GlobeIcon,
	HeartIcon,
	ImageIcon,
	StarIcon,
} from "lucide-react";

const FOLDER_ICONS = {
	folder: FolderIcon,
	star: StarIcon,
	globe: GlobeIcon,
	code: CodeIcon,
	briefcase: BriefcaseIcon,
	image: ImageIcon,
	heart: HeartIcon,
	book: BookIcon,
	file: FileIcon,
} as const;

export type BrowserBookmarkFolderIconKey = keyof typeof FOLDER_ICONS;

export interface BrowserBookmarkFolderIconOption {
	key: BrowserBookmarkFolderIconKey;
	label: string;
	icon: LucideIcon;
}

export const BROWSER_BOOKMARK_FOLDER_ICON_OPTIONS: BrowserBookmarkFolderIconOption[] =
	[
		{ key: "folder", label: "Folder", icon: FolderIcon },
		{ key: "star", label: "Star", icon: StarIcon },
		{ key: "globe", label: "Globe", icon: GlobeIcon },
		{ key: "code", label: "Code", icon: CodeIcon },
		{ key: "briefcase", label: "Briefcase", icon: BriefcaseIcon },
		{ key: "image", label: "Image", icon: ImageIcon },
		{ key: "heart", label: "Heart", icon: HeartIcon },
		{ key: "book", label: "Book", icon: BookIcon },
		{ key: "file", label: "File", icon: FileIcon },
	];

export function isBrowserBookmarkFolderIconKey(
	value: unknown,
): value is BrowserBookmarkFolderIconKey {
	return typeof value === "string" && value in FOLDER_ICONS;
}

export function getBrowserBookmarkFolderIcon(
	iconKey?: BrowserBookmarkFolderIconKey,
): LucideIcon {
	return FOLDER_ICONS[iconKey ?? "folder"] ?? FolderIcon;
}
