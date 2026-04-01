import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface BrowserBookmark {
	id: string;
	url: string;
	title: string;
	faviconUrl?: string;
	createdAt: number;
}

interface BrowserBookmarkInput {
	url: string;
	title: string;
	faviconUrl?: string;
}

interface BrowserBookmarksState {
	bookmarks: BrowserBookmark[];
	addBookmark: (bookmark: BrowserBookmarkInput) => BrowserBookmark | null;
	updateBookmark: (
		bookmarkId: string,
		bookmark: BrowserBookmarkInput,
	) => BrowserBookmark | null;
	removeBookmark: (bookmarkId: string) => void;
	moveBookmark: (activeId: string, overId: string) => void;
	toggleBookmark: (bookmark: BrowserBookmarkInput) => boolean;
}

export function normalizeBookmarkUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed || trimmed === "about:blank") return trimmed;

	try {
		const parsed = new URL(trimmed);
		if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
			return parsed.origin;
		}
		return parsed.toString();
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

function findBookmarkIndex(bookmarks: BrowserBookmark[], url: string): number {
	const normalizedUrl = normalizeBookmarkUrl(url);
	return bookmarks.findIndex(
		(bookmark) => normalizeBookmarkUrl(bookmark.url) === normalizedUrl,
	);
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
	if (fromIndex === toIndex) return items;
	const nextItems = [...items];
	const [movedItem] = nextItems.splice(fromIndex, 1);
	if (!movedItem) return items;
	nextItems.splice(toIndex, 0, movedItem);
	return nextItems;
}

export const useBrowserBookmarksStore = create<BrowserBookmarksState>()(
	devtools(
		persist(
			(set, get) => ({
				bookmarks: [],

				addBookmark: (bookmark) => {
					const normalizedUrl = normalizeBookmarkUrl(bookmark.url);
					if (!normalizedUrl || normalizedUrl === "about:blank") {
						return null;
					}

					const title = bookmark.title.trim() || normalizedUrl;
					const existingIndex = findBookmarkIndex(
						get().bookmarks,
						normalizedUrl,
					);
					if (existingIndex >= 0) {
						const existingBookmark = get().bookmarks[existingIndex];
						if (!existingBookmark) return null;
						const updatedBookmark = {
							...existingBookmark,
							url: normalizedUrl,
							title,
							faviconUrl: bookmark.faviconUrl ?? existingBookmark.faviconUrl,
						};
						set((state) => ({
							bookmarks: state.bookmarks.map((entry, index) =>
								index === existingIndex ? updatedBookmark : entry,
							),
						}));
						return updatedBookmark;
					}

					const nextBookmark: BrowserBookmark = {
						id: crypto.randomUUID(),
						url: normalizedUrl,
						title,
						faviconUrl: bookmark.faviconUrl,
						createdAt: Date.now(),
					};

					set((state) => ({
						bookmarks: [...state.bookmarks, nextBookmark],
					}));

					return nextBookmark;
				},

				updateBookmark: (bookmarkId, bookmark) => {
					const normalizedUrl = normalizeBookmarkUrl(bookmark.url);
					if (!normalizedUrl || normalizedUrl === "about:blank") {
						return null;
					}

					const targetBookmark = get().bookmarks.find(
						(entry) => entry.id === bookmarkId,
					);
					if (!targetBookmark) return null;

					const duplicateBookmark = get().bookmarks.find(
						(entry) =>
							entry.id !== bookmarkId &&
							normalizeBookmarkUrl(entry.url) === normalizedUrl,
					);
					if (duplicateBookmark) {
						return null;
					}

					const updatedBookmark: BrowserBookmark = {
						...targetBookmark,
						url: normalizedUrl,
						title: bookmark.title.trim() || normalizedUrl,
						faviconUrl: bookmark.faviconUrl ?? targetBookmark.faviconUrl,
					};

					set((state) => ({
						bookmarks: state.bookmarks.map((entry) =>
							entry.id === bookmarkId ? updatedBookmark : entry,
						),
					}));

					return updatedBookmark;
				},

				removeBookmark: (bookmarkId) => {
					set((state) => ({
						bookmarks: state.bookmarks.filter(
							(bookmark) => bookmark.id !== bookmarkId,
						),
					}));
				},

				moveBookmark: (activeId, overId) => {
					if (activeId === overId) return;
					set((state) => {
						const fromIndex = state.bookmarks.findIndex(
							(bookmark) => bookmark.id === activeId,
						);
						const toIndex = state.bookmarks.findIndex(
							(bookmark) => bookmark.id === overId,
						);
						if (fromIndex < 0 || toIndex < 0) return state;
						return {
							bookmarks: moveItem(state.bookmarks, fromIndex, toIndex),
						};
					});
				},

				toggleBookmark: (bookmark) => {
					const existingIndex = findBookmarkIndex(
						get().bookmarks,
						bookmark.url,
					);
					if (existingIndex >= 0) {
						const existingBookmark = get().bookmarks[existingIndex];
						if (existingBookmark) {
							get().removeBookmark(existingBookmark.id);
						}
						return false;
					}

					return get().addBookmark(bookmark) !== null;
				},
			}),
			{
				name: "browser-bookmarks-store",
				version: 1,
			},
		),
		{ name: "BrowserBookmarksStore" },
	),
);
